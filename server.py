import os
import cv2
import csv
import time
import datetime
import base64
import numpy as np
import pandas as pd
from collections import defaultdict, deque
from PIL import Image
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request, Query
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import asyncio
import uvicorn

# ---- Face Recognition & Detection Configuration Constants ----
FACE_SIZE = 200          # Uniform face crop dimension
CONFIDENCE_THRESHOLD = 80 # LBPH distance threshold (lower = stricter/better match, rejecting > 80)

# Haar Cascade Parameters
HAAR_SCALE_FACTOR = 1.2
HAAR_MIN_NEIGHBORS = 5
HAAR_MIN_SIZE_REG = (80, 80)
HAAR_MIN_SIZE_ATT = (60, 60)

# LBPH Face Recognizer Parameters
LBPH_RADIUS = 1
LBPH_NEIGHBORS = 8
LBPH_GRID_X = 8
LBPH_GRID_Y = 8

def preprocess_face(face_img):
    """Apply CLAHE + mild Gaussian Blur + resize to a grayscale face crop.
    This must be used identically during training and recognition."""
    # Resize to uniform dimensions
    face_resized = cv2.resize(face_img, (FACE_SIZE, FACE_SIZE))
    # Mild Gaussian blur: reduce high frequency noise while preserving LBP spatial patterns
    face_filtered = cv2.GaussianBlur(face_resized, (3, 3), 0)
    # CLAHE: adaptive histogram equalization for lighting robustness
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    face_clahe = clahe.apply(face_filtered)
    return face_clahe

DATA_DIR = os.getenv("DATA_DIR", ".")

def get_data_path(*paths):
    return os.path.join(DATA_DIR, *paths)

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Attendease Web Server")

# Configure CORS to allow any origin to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount Static Files Directory
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

# Add no-cache middleware for static files to prevent stale JS/CSS on redeployment
from starlette.middleware.base import BaseHTTPMiddleware

class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/") or request.url.path == "/":
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

app.add_middleware(NoCacheStaticMiddleware)

# Shared Recognizer instance
recognizer = cv2.face.LBPHFaceRecognizer_create(
    radius=LBPH_RADIUS, 
    neighbors=LBPH_NEIGHBORS, 
    grid_x=LBPH_GRID_X, 
    grid_y=LBPH_GRID_Y
)
recognizer_loaded = False

def reload_recognizer():
    global recognizer_loaded, recognizer
    trainer_path = get_data_path("TrainingImageLabel", "Trainner.yml")
    if os.path.isfile(trainer_path):
        try:
            recognizer.read(trainer_path)
            recognizer_loaded = True
            print("LBPH Recognizer model loaded successfully.")
        except Exception as e:
            print(f"Error loading recognizer: {e}")
            recognizer_loaded = False
    else:
        recognizer_loaded = False
        print("LBPH Recognizer trainer file not found. Ready to train.")

# Load recognizer on startup
reload_recognizer()

# Helpers matching original codebase logic
def assure_path_exists(path):
    dir_name = os.path.dirname(path)
    if dir_name and not os.path.exists(dir_name):
        os.makedirs(dir_name)

def check_haarcascadefile():
    return os.path.isfile("haarcascade_frontalface_default.xml")

def get_registration_count():
    res = 0
    csv_path = get_data_path("StudentDetails", "StudentDetails.csv")
    if os.path.isfile(csv_path):
        try:
            with open(csv_path, 'r', encoding='utf-8') as csvFile:
                reader = csv.reader(csvFile)
                for row in reader:
                    if len(row) >= 5 and row[0].strip() != '' and row[0].strip() != 'SERIAL NO.':
                        res += 1
        except Exception as e:
            print(f"Error reading registration count: {e}")
    return res

def get_next_serial():
    max_serial = 0
    csv_path = get_data_path("StudentDetails", "StudentDetails.csv")
    if os.path.isfile(csv_path):
        try:
            with open(csv_path, 'r', encoding='utf-8') as csvFile:
                reader = csv.reader(csvFile)
                for row in reader:
                    if len(row) >= 5 and row[0].strip() != '' and row[0].strip() != 'SERIAL NO.':
                        try:
                            val = int(row[0].strip())
                            if val > max_serial:
                                max_serial = val
                        except ValueError:
                            continue
            return max_serial + 1
        except Exception as e:
            print(f"Error reading next serial: {e}")
            return 1
    else:
        return 1

# Pydantic Schemas
class ChangePasswordRequest(BaseModel):
    old_pass: str
    new_pass: str
    confirm_pass: str

class PasswordVerifyRequest(BaseModel):
    password: str

class ResetRequest(BaseModel):
    password: str

# ----------------------------------------------------
# HTTP ROUTING
# ----------------------------------------------------

# Root: Serves index.html SPA dashboard
@app.get("/", response_class=HTMLResponse)
async def get_index():
    index_path = "index.html"
    if os.path.isfile(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            content = f.read()
        return HTMLResponse(
            content=content,
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0"
            }
        )
    else:
        raise HTTPException(status_code=404, detail="index.html not found in root directory")

# Debug endpoint to diagnose Railway filesystem issues
@app.get("/api/debug")
async def api_debug():
    image_dir = get_data_path("TrainingImage")
    model_path = get_data_path("TrainingImageLabel", "Trainner.yml")
    csv_path = get_data_path("StudentDetails", "StudentDetails.csv")
    
    image_count = 0
    if os.path.exists(image_dir):
        image_count = len([f for f in os.listdir(image_dir) if f.endswith(".jpg")])
    
    return {
        "data_dir": DATA_DIR,
        "data_dir_resolved": os.path.abspath(DATA_DIR),
        "cwd": os.getcwd(),
        "training_images_dir": os.path.abspath(image_dir),
        "training_images_exist": os.path.exists(image_dir),
        "training_image_count": image_count,
        "model_path": os.path.abspath(model_path),
        "model_exists": os.path.isfile(model_path),
        "csv_path": os.path.abspath(csv_path),
        "csv_exists": os.path.isfile(csv_path),
        "haar_cascade_exists": check_haarcascadefile(),
        "recognizer_loaded": recognizer_loaded
    }

# API Stats
@app.get("/api/stats")
async def get_stats():
    # Present count today
    present_today = 0
    last_marked = None
    
    date_str = datetime.datetime.now().strftime('%d-%m-%Y')
    attendance_file = get_data_path("Attendance", f"Attendance_{date_str}.csv")
    
    if os.path.isfile(attendance_file):
        with open(attendance_file, 'r') as f:
            reader = csv.reader(f)
            rows = list(reader)
            # Filter headers and empty lines
            records = [r for r in rows if len(r) > 0 and r[0] != 'Id']
            # Divide by 2 due to Windows empty rows behavior if written with standard text mode
            present_today = len(records)
            
            if len(records) > 0:
                last_row = records[-1]
                last_marked = {
                    "id": last_row[0],
                    "name": last_row[2],
                    "date": last_row[4],
                    "time": last_row[6]
                }
                
    registered_count = get_registration_count()
    absent_count = max(0, registered_count - present_today)
                
    return {
        "registered_count": registered_count,
        "present_today": present_today,
        "absent_count": absent_count,
        "last_marked": last_marked,
        "model_exists": os.path.isfile(get_data_path("TrainingImageLabel", "Trainner.yml"))
    }

# Today's attendance list
@app.get("/api/attendance/today")
async def get_today_attendance():
    date_str = datetime.datetime.now().strftime('%d-%m-%Y')
    attendance_file = get_data_path("Attendance", f"Attendance_{date_str}.csv")
    records = []
    
    if os.path.isfile(attendance_file):
        with open(attendance_file, 'r') as f:
            reader = csv.reader(f)
            for r in reader:
                if len(r) > 0 and r[0] != 'Id':
                    records.append({
                        "id": r[0],
                        "name": r[2],
                        "date": r[4],
                        "time": r[6]
                    })
    # Reverse to show latest first
    records.reverse()
    return {"records": records}

# Attendance history list & detail viewer
@app.get("/api/attendance/history")
async def get_attendance_history(filename: str = Query(None), download: bool = Query(False)):
    attendance_dir = get_data_path("Attendance")
    os.makedirs(attendance_dir, exist_ok=True)
    
    # If a specific filename is requested
    if filename:
        # Sanitization
        filename = os.path.basename(filename)
        file_path = os.path.join(attendance_dir, filename)
        
        if not os.path.isfile(file_path):
            raise HTTPException(status_code=404, detail="Attendance file not found")
            
        if download:
            return FileResponse(
                path=file_path,
                filename=filename,
                media_type="text/csv",
                headers={"Content-Disposition": f"attachment; filename={filename}"}
            )
            
        records = []
        with open(file_path, 'r') as f:
            reader = csv.reader(f)
            for r in reader:
                if len(r) > 0 and r[0] != 'Id':
                    records.append({
                        "id": r[0],
                        "name": r[2],
                        "date": r[4],
                        "time": r[6]
                    })
        return {"records": records}
        
    # Otherwise list all history files
    files_list = []
    if os.path.exists(attendance_dir):
        files = [f for f in os.listdir(attendance_dir) if f.startswith("Attendance_") and f.endswith(".csv")]
        for f in files:
            # Extract date from Attendance_DD-MM-YYYY.csv
            parts = f.replace("Attendance_", "").replace(".csv", "").split("-")
            if len(parts) == 3:
                date_display = f"{parts[0]} {parts[1]} {parts[2]}"
                files_list.append({
                    "filename": f,
                    "date": date_display,
                    "raw_date": f.replace("Attendance_", "").replace(".csv", "")
                })
                
    # Sort files by newest date
    def parse_file_date(item):
        try:
            return datetime.datetime.strptime(item["raw_date"], "%d-%m-%Y")
        except:
            return datetime.datetime.min
            
    files_list.sort(key=parse_file_date, reverse=True)
    return {"files": files_list}

# Model Trainer Endpoint
@app.post("/api/train")
async def api_train_model():
    if not check_haarcascadefile():
        raise HTTPException(status_code=500, detail="Haar cascade file not found on server!")
        
    image_dir = get_data_path("TrainingImage")
    os.makedirs(image_dir, exist_ok=True)
    
    # Run CPU intensive trainer in a thread pool to avoid blocking Event Loop
    def train_task():
        image_paths = [os.path.join(image_dir, f) for f in os.listdir(image_dir) if f.endswith(".jpg")]
        print(f"[TRAIN] Found {len(image_paths)} image files in {image_dir}")
        faces = []
        ids = []
        skipped = 0
        
        for image_path in image_paths:
            try:
                pil_image = Image.open(image_path).convert('L')
                image_np = np.array(pil_image, 'uint8')
                # File format: {name}.{serial}.{student_id}.{sampleNum}.jpg
                filename = os.path.split(image_path)[-1]
                parts = filename.split(".")
                if len(parts) >= 3:
                    serial_no = int(parts[1])
                    
                    # Preprocess the face for consistent feature extraction
                    processed = preprocess_face(image_np)
                    faces.append(processed)
                    ids.append(serial_no)
                    
                    # Augmentation 1: horizontal flip (doubles training data)
                    flipped = cv2.flip(processed, 1)
                    faces.append(flipped)
                    ids.append(serial_no)
                    
                    # Augmentation 2: rotate left by 5 degrees (handles slight head tilts)
                    h_h, w_w = processed.shape[:2]
                    center = (w_w // 2, h_h // 2)
                    m_left = cv2.getRotationMatrix2D(center, 5, 1.0)
                    rotated_left = cv2.warpAffine(processed, m_left, (w_w, h_h))
                    faces.append(rotated_left)
                    ids.append(serial_no)
                    
                    # Augmentation 3: rotate right by 5 degrees
                    m_right = cv2.getRotationMatrix2D(center, -5, 1.0)
                    rotated_right = cv2.warpAffine(processed, m_right, (w_w, h_h))
                    faces.append(rotated_right)
                    ids.append(serial_no)
                else:
                    skipped += 1
                    print(f"[TRAIN] Skipping file with unexpected name format: {filename}")
                    
            except Exception as ex:
                skipped += 1
                print(f"[TRAIN] Skipping bad image {image_path}: {ex}")
                
        if len(faces) == 0:
            return False, f"No student face data found. {len(image_paths)} files scanned, {skipped} skipped. Register someone first!"
            
        print(f"[TRAIN] Training LBPH with {len(faces)} face samples from {len(set(ids))} unique IDs")
        
        try:
            # Tuned LBPH: configured using global constants
            rec = cv2.face.LBPHFaceRecognizer_create(
                radius=LBPH_RADIUS, 
                neighbors=LBPH_NEIGHBORS, 
                grid_x=LBPH_GRID_X, 
                grid_y=LBPH_GRID_Y
            )
            rec.train(faces, np.array(ids, dtype=np.int32))
            os.makedirs(get_data_path("TrainingImageLabel"), exist_ok=True)
            rec.save(get_data_path("TrainingImageLabel", "Trainner.yml"))
            total_samples = len(faces)
            print(f"[TRAIN] Success! Model saved with {total_samples} samples")
            return True, f"Model trained successfully with {total_samples} augmented samples!"
        except Exception as ex:
            print(f"[TRAIN] LBPH train/save error: {ex}")
            return False, f"Model training failed: {str(ex)}"
    
    try:
        success, msg = await asyncio.to_thread(train_task)
        if not success:
            raise HTTPException(status_code=400, detail=msg)
    except HTTPException:
        raise
    except Exception as ex:
        print(f"[TRAIN] Unexpected error: {ex}")
        raise HTTPException(status_code=500, detail=f"Training crashed: {str(ex)}")
        
    # Reload model in server memory
    reload_recognizer()
    return {"message": msg}

# Change Admin Password
@app.post("/api/change-password")
async def api_change_password(req: ChangePasswordRequest):
    psd_file = get_data_path("TrainingImageLabel", "psd.txt")
    assure_path_exists(psd_file)
    
    if os.path.isfile(psd_file):
        with open(psd_file, "r") as f:
            key = f.read().strip()
    else:
        # Default password if txt doesn't exist
        key = ""
        
    if key and req.old_pass != key:
        raise HTTPException(status_code=401, detail="Incorrect old password!")
        
    if req.new_pass != req.confirm_pass:
        raise HTTPException(status_code=400, detail="New passwords do not match!")
        
    with open(psd_file, "w") as f:
        f.write(req.new_pass)
        
    return {"message": "Password updated successfully!"}

# Verify Admin Password
@app.post("/api/verify-password")
async def api_verify_password(req: PasswordVerifyRequest):
    psd_file = get_data_path("TrainingImageLabel", "psd.txt")
    if os.path.isfile(psd_file):
        with open(psd_file, "r") as f:
            key = f.read().strip()
    else:
        key = ""
        
    if key and req.password != key:
        raise HTTPException(status_code=401, detail="Incorrect admin password!")
    return {"status": "ok"}

# Reset System Database securely
@app.post("/api/reset")
async def api_reset_system(req: ResetRequest):
    psd_file = get_data_path("TrainingImageLabel", "psd.txt")
    if os.path.isfile(psd_file):
        with open(psd_file, "r") as f:
            key = f.read().strip()
    else:
        key = ""
        
    if key and req.password != key:
        raise HTTPException(status_code=401, detail="Incorrect admin password!")
        
    try:
        # 1. Clear TrainingImage/ directory
        image_dir = get_data_path("TrainingImage")
        if os.path.exists(image_dir):
            for filename in os.listdir(image_dir):
                file_path = os.path.join(image_dir, filename)
                try:
                    if os.path.isfile(file_path):
                        os.remove(file_path)
                except Exception as e:
                    print(f"[RESET] Error removing {file_path}: {e}")
                    
        # 2. Delete Trainer model
        trainer_path = get_data_path("TrainingImageLabel", "Trainner.yml")
        if os.path.isfile(trainer_path):
            try:
                os.remove(trainer_path)
            except Exception as e:
                print(f"[RESET] Error removing {trainer_path}: {e}")
                
        # 3. Delete password file to reset password to default empty string
        if os.path.isfile(psd_file):
            try:
                os.remove(psd_file)
            except Exception as e:
                print(f"[RESET] Error removing {psd_file}: {e}")
                
        # 4. Reinitialize StudentDetails.csv
        csv_path = get_data_path("StudentDetails", "StudentDetails.csv")
        if os.path.exists(os.path.dirname(csv_path)):
            try:
                with open(csv_path, 'w', newline='', encoding='utf-8') as csvFile:
                    writer = csv.writer(csvFile)
                    writer.writerow(['SERIAL NO.', '', 'ID', '', 'NAME'])
            except Exception as e:
                print(f"[RESET] Error resetting {csv_path}: {e}")
                
        # 5. Clear Attendance/ directory
        attendance_dir = get_data_path("Attendance")
        if os.path.exists(attendance_dir):
            for filename in os.listdir(attendance_dir):
                file_path = os.path.join(attendance_dir, filename)
                try:
                    if os.path.isfile(file_path):
                        os.remove(file_path)
                except Exception as e:
                    print(f"[RESET] Error removing {file_path}: {e}")
                    
        # Reload the recognizer (which will now set recognizer_loaded = False)
        reload_recognizer()
        
        return {"message": "System database reset successfully. Ready to start fresh!"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Reset failed: {e}")

# List all registered students
@app.get("/api/students")
async def api_get_students():
    students = []
    csv_path = get_data_path("StudentDetails", "StudentDetails.csv")
    if os.path.isfile(csv_path):
        try:
            with open(csv_path, 'r', encoding='utf-8') as f:
                reader = csv.reader(f)
                # Read header
                header = next(reader, None)
                for row in reader:
                    if len(row) >= 5 and row[0].strip() != '' and row[0].strip() != 'SERIAL NO.':
                        students.append({
                            "serial": int(row[0].strip()),
                            "id": row[2].strip(),
                            "name": row[4].strip()
                        })
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error reading student details: {e}")
    return {"students": students}

# Remove a registered student and their training face samples
@app.delete("/api/students/{student_id}")
async def api_delete_student(student_id: str):
    csv_path = get_data_path("StudentDetails", "StudentDetails.csv")
    if not os.path.isfile(csv_path):
        raise HTTPException(status_code=404, detail="Student details file not found.")
        
    updated_rows = []
    student_found = False
    student_serial = None
    student_name = ""
    
    try:
        with open(csv_path, 'r', encoding='utf-8') as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if header:
                updated_rows.append(header)
            for row in reader:
                if len(row) >= 5:
                    curr_id = row[2].strip()
                    if curr_id == student_id:
                        student_found = True
                        student_serial = row[0].strip()
                        student_name = row[4].strip()
                    else:
                        updated_rows.append(row)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading student details: {e}")
        
    if not student_found:
        raise HTTPException(status_code=404, detail="Student not found.")
        
    try:
        # Write back filtered records
        with open(csv_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerows(updated_rows)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error writing to student details: {e}")
        
    # Delete student's face images from TrainingImage/ directory
    image_dir = get_data_path("TrainingImage")
    deleted_images_count = 0
    if os.path.exists(image_dir) and student_serial:
        try:
            for filename in os.listdir(image_dir):
                parts = filename.split(".")
                if len(parts) >= 3:
                    # parts[1] is serial, parts[2] is id
                    if parts[1].strip() == str(student_serial).strip() and parts[2].strip() == student_id.strip():
                        try:
                            os.remove(os.path.join(image_dir, filename))
                            deleted_images_count += 1
                        except Exception as ex:
                            print(f"Error deleting image {filename}: {ex}")
        except Exception as e:
            print(f"Error scanning TrainingImage directory: {e}")
            
    return {
        "message": f"Student {student_name} (ID: {student_id}) removed successfully.",
        "deleted_images": deleted_images_count
    }

# Remove an attendance log record
@app.delete("/api/attendance")
async def api_delete_attendance(filename: str = Query(...), student_id: str = Query(...), time_logged: str = Query(...)):
    filename = os.path.basename(filename)
    attendance_dir = get_data_path("Attendance")
    file_path = os.path.join(attendance_dir, filename)
    
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Attendance file not found")
        
    updated_rows = []
    found = False
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if header:
                updated_rows.append(header)
            for row in reader:
                if len(row) >= 7:
                    curr_id = row[0].strip()
                    curr_time = row[6].strip()
                    if curr_id == student_id and curr_time == time_logged:
                        found = True
                    else:
                        updated_rows.append(row)
                else:
                    updated_rows.append(row)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading attendance file: {e}")
        
    if not found:
        raise HTTPException(status_code=404, detail="Attendance record not found")
        
    try:
        with open(file_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerows(updated_rows)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error writing to attendance file: {e}")
        
    return {"message": f"Attendance record for student ID {student_id} removed successfully."}

# ----------------------------------------------------
# WEBSOCKET STREAMING HANDLERS
# ----------------------------------------------------

# WebSocket: Capture images & Register student
@app.websocket("/ws/register")
async def websocket_register(websocket: WebSocket, id: str = Query(...), name: str = Query(...), password: str = Query(...)):
    await websocket.accept()
    
    # Check admin password
    psd_file = get_data_path("TrainingImageLabel", "psd.txt")
    if os.path.isfile(psd_file):
        with open(psd_file, "r") as f:
            key = f.read().strip()
    else:
        key = ""
        
    if key and password != key:
        await websocket.send_json({"status": "error", "message": "Incorrect admin password!"})
        await websocket.close()
        return
        
    if not check_haarcascadefile():
        await websocket.send_json({"status": "error", "message": "Haar cascade file missing on server."})
        await websocket.close()
        return
        
    os.makedirs(get_data_path("StudentDetails"), exist_ok=True)
    os.makedirs(get_data_path("TrainingImage"), exist_ok=True)

    # Check if student ID already exists to prevent duplicates
    csv_path = get_data_path("StudentDetails", "StudentDetails.csv")
    if os.path.isfile(csv_path):
        try:
            with open(csv_path, 'r', encoding='utf-8') as f:
                reader = csv.reader(f)
                next(reader, None)  # Skip header
                for row in reader:
                    if len(row) >= 5 and row[2].strip() == id.strip():
                        await websocket.send_json({"status": "error", "message": f"Student ID '{id}' is already registered!"})
                        await websocket.close()
                        return
        except Exception as e:
            print(f"Error checking duplicate ID: {e}")
    
    detector = cv2.CascadeClassifier("haarcascade_frontalface_default.xml")
    serial = get_next_serial()
    sampleNum = 0
    
    # Set columns for csv if it doesn't exist
    csv_path = get_data_path("StudentDetails", "StudentDetails.csv")
    if not os.path.isfile(csv_path):
        with open(csv_path, 'a+', newline='', encoding='utf-8') as csvFile:
            writer = csv.writer(csvFile)
            writer.writerow(['SERIAL NO.', '', 'ID', '', 'NAME'])
            serial = 1
            
    try:
        while sampleNum < 100:
            data = await websocket.receive_text()
            
            # Decode frame image
            image_data = base64.b64decode(data)
            nparr = np.frombuffer(image_data, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if img is None:
                continue
                
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            faces = detector.detectMultiScale(
                gray, 
                scaleFactor=HAAR_SCALE_FACTOR, 
                minNeighbors=HAAR_MIN_NEIGHBORS, 
                minSize=HAAR_MIN_SIZE_REG
            )
            
            if len(faces) > 0:
                # Select only the single largest face to avoid background clutter or secondary faces
                faces = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
                (x, y, w, h) = faces[0]
                
                sampleNum += 1
                face_crop = gray[y:y + h, x:x + w]
                # Save the raw face crop directly to disk (mismatch corrected: preprocessing is applied exactly once during training)
                cv2.imwrite(get_data_path("TrainingImage", f"{name}.{serial}.{id}.{sampleNum}.jpg"), face_crop)
                
                # Send progress update
                await websocket.send_json({"status": "capturing", "count": sampleNum})
                    
        # Write registration row to StudentDetails.csv
        # Mimic the double-comma blank field layout of the original app
        row = [serial, '', id, '', name]
        with open(csv_path, 'a+', newline='', encoding='utf-8') as csvFile:
            writer = csv.writer(csvFile)
            writer.writerow(row)
            
        await websocket.send_json({"status": "completed"})
        
    except WebSocketDisconnect:
        print("Registration WebSocket disconnected.")
    except Exception as e:
        print(f"Error in registration loop: {e}")
        try:
            await websocket.send_json({"status": "error", "message": str(e)})
        except:
            pass
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass

# Helper function to process frame in thread pool
def process_attendance_frame(gray, detector, recognizer_loaded, recognizer, student_map, confidence_history):
    # Detect faces in original resolution grayscale frame with aligned parameters
    faces_detected = detector.detectMultiScale(
        gray, 
        scaleFactor=HAAR_SCALE_FACTOR, 
        minNeighbors=HAAR_MIN_NEIGHBORS, 
        minSize=HAAR_MIN_SIZE_ATT
    )
    
    results = []
    for (x, y, w, h) in faces_detected:
        student_name = "Unknown"
        student_id = ""
        serial_val = None
        raw_confidence = None
        
        if recognizer_loaded:
            try:
                # Crop face region and apply same preprocessing as training
                crop_face = gray[y:y + h, x:x + w]
                if crop_face.shape[0] > 0 and crop_face.shape[1] > 0:
                    processed_face = preprocess_face(crop_face)
                    serial, confidence = recognizer.predict(processed_face)
                    raw_confidence = confidence
                    
                    # Debug: log confidence values to diagnose recognition issues
                    print(f"[RECOGNITION] Serial={serial}, Confidence={confidence:.1f}, Student={'KNOWN' if serial in student_map else 'NOT_IN_MAP'}")
                    
                    # LBPH distance metric: lower = better match. Reject if confidence >= CONFIDENCE_THRESHOLD
                    if confidence < CONFIDENCE_THRESHOLD:
                        # Multi-frame averaging: track predictions by face region
                        cx = (x + w // 2) // 50
                        cy = (y + h // 2) // 50
                        region_key = (cx, cy)
                        
                        confidence_history[region_key].append(serial)
                        
                        # Keep only last 5 predictions
                        if len(confidence_history[region_key]) > 5:
                            confidence_history[region_key].popleft()
                        
                        # Show identity immediately if in student_map
                        # Multi-frame voting adds stability but shouldn't block first match
                        if serial in student_map:
                            serial_val = serial
                            student_id = student_map[serial]["id"]
                            student_name = student_map[serial]["name"]
                            
                            # If we have history, use voting for even more stability
                            history = confidence_history[region_key]
                            if len(history) >= 3:
                                from collections import Counter
                                vote_counts = Counter(history)
                                best_serial, best_count = vote_counts.most_common(1)[0]
                                if best_serial in student_map:
                                    serial_val = best_serial
                                    student_id = student_map[best_serial]["id"]
                                    student_name = student_map[best_serial]["name"]
                    else:
                        print(f"[RECOGNITION] REJECTED: confidence {confidence:.1f} >= {CONFIDENCE_THRESHOLD} threshold")
            except Exception as e:
                print(f"Error predicting face: {e}")
                
        results.append({
            "x": int(x),
            "y": int(y),
            "w": int(w),
            "h": int(h),
            "name": student_name,
            "id": student_id,
            "serial": serial_val
        })
    return results

# WebSocket: Mark attendance in real time
@app.websocket("/ws/attendance")
async def websocket_attendance(websocket: WebSocket):
    await websocket.accept()
    
    if not check_haarcascadefile():
        await websocket.send_json({"status": "error", "message": "Haar cascade file missing."})
        await websocket.close()
        return
        
    detector = cv2.CascadeClassifier("haarcascade_frontalface_default.xml")
    
    # Fetch student mappings from details CSV for fast lookup
    student_map = {}
    csv_path = get_data_path("StudentDetails", "StudentDetails.csv")
    if os.path.isfile(csv_path):
        try:
            df = pd.read_csv(csv_path)
            # Remove any empty spaces or blank columns from CSV headers
            df.columns = df.columns.str.strip()
            df = df.dropna(subset=['SERIAL NO.', 'ID', 'NAME'])
            for _, row in df.iterrows():
                try:
                    s_no = int(row['SERIAL NO.'])
                    student_map[s_no] = {
                        "id": str(row['ID']).strip(),
                        "name": str(row['NAME']).strip()
                    }
                except:
                    continue
        except Exception as e:
            print(f"Error parsing StudentDetails.csv: {e}")
            
    # Keep track of marked IDs in this active websocket session
    marked_in_session = set()
    
    # Multi-frame confidence history: tracks rolling predictions per face region
    confidence_history = defaultdict(deque)
    
    # Load today's list of marked IDs from CSV to avoid duplicate triggers
    ts = time.time()
    date_str = datetime.datetime.fromtimestamp(ts).strftime('%d-%m-%Y')
    attendance_file = get_data_path("Attendance", f"Attendance_{date_str}.csv")
    assure_path_exists(attendance_file)
    
    col_names = ['Id', '', 'Name', '', 'Date', '', 'Time']
    if not os.path.isfile(attendance_file):
        with open(attendance_file, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(col_names)
            
    marked_today = set()
    if os.path.isfile(attendance_file):
        with open(attendance_file, 'r') as f:
            reader = csv.reader(f)
            for line in reader:
                if len(line) > 0 and line[0] != 'Id':
                    marked_today.add(line[0])
                    
    try:
        while True:
            data = await websocket.receive_text()
            
            # Decode frame
            image_data = base64.b64decode(data)
            nparr = np.frombuffer(image_data, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if img is None:
                continue
                
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            
            # Offload computer vision processing to thread pool
            detected_results = await asyncio.to_thread(
                process_attendance_frame,
                gray,
                detector,
                recognizer_loaded,
                recognizer,
                student_map,
                confidence_history
            )
            
            faces_payload = []
            attendance_marked = False
            already_marked_alert = False
            marked_student = None
            
            for face in detected_results:
                face_status = "unknown"
                student_name = face["name"]
                student_id = face["id"]
                
                if student_id:
                    # Attendance logic
                    if student_id not in marked_today and student_id not in marked_in_session:
                        # Log Attendance
                        ts_now = time.time()
                        time_str = datetime.datetime.fromtimestamp(ts_now).strftime('%H:%M:%S')
                        date_str = datetime.datetime.fromtimestamp(ts_now).strftime('%d-%m-%Y')
                        
                        # Write row matching Tkinter template
                        row = [student_id, '', student_name, '', date_str, '', time_str]
                        with open(attendance_file, 'a', newline='', encoding='utf-8') as f:
                            writer = csv.writer(f)
                            writer.writerow(row)
                            
                        marked_today.add(student_id)
                        marked_in_session.add(student_id)
                        
                        face_status = "marked"
                        attendance_marked = True
                        marked_student = {"id": student_id, "name": student_name, "time": time_str}
                        
                    elif student_id in marked_today:
                        face_status = "already_marked"
                        # Only alert the client if we haven't already marked/alerted in this socket session
                        if student_id not in marked_in_session:
                            marked_in_session.add(student_id)
                            already_marked_alert = True
                            marked_student = {"id": student_id, "name": student_name}
                else:
                    face_status = "unknown"
                    student_name = "Unknown"
                    
                # Convert coords to JSON list
                faces_payload.append({
                    "x": face["x"],
                    "y": face["y"],
                    "w": face["w"],
                    "h": face["h"],
                    "name": student_name,
                    "id": student_id,
                    "status": face_status
                })
                
            # Send results back
            response_data = {
                "faces": faces_payload,
                "attendance_marked": attendance_marked,
                "already_marked_alert": already_marked_alert,
                "marked_student": marked_student
            }
            await websocket.send_json(response_data)
            
    except WebSocketDisconnect:
        print("Attendance WebSocket disconnected.")
    except Exception as e:
        print(f"Error in attendance loop: {e}")
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass

if __name__ == "__main__":
    import socket
    def find_available_port(start_port=8000, host="0.0.0.0"):
        port = start_port
        ports_to_try = [8000, 8080, 8081, 5000, 8001] + list(range(start_port, start_port + 100))
        for p in ports_to_try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                try:
                    s.bind((host, p))
                    return p
                except OSError:
                    continue
        return start_port

    port = find_available_port()
    print(f"Starting server directly. Navigate to: http://localhost:{port}")
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)
