// Helper for dynamic backend API URL routing (for remote frontend deployments)
function getBackendUrl() {
    const url = localStorage.getItem('attendease_backend_url');
    return url ? url.trim().replace(/\/$/, '') : '';
}

// Global Variables
let wsAttendance = null;
let wsRegister = null;
let activeCamStream = null;
let activeRegStream = null;
let attendanceInterval = null;
let registerInterval = null;
let dashboardInterval = null;

// Constant Frame dimensions
const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 480;

// DOM Elements
const txtClock = document.getElementById('txt-clock');
const txtDate = document.getElementById('txt-date');
const navItems = document.querySelectorAll('.nav-menu a');
const screens = document.querySelectorAll('.screen-view');
const screenTitle = document.getElementById('screen-title');
const screenSubtitle = document.getElementById('screen-subtitle');

// Navigation Subtitle Mapping
const screenSubtitles = {
    'screen-dashboard': "Overview of current registrations and today's attendance logs.",
    'screen-mark-attendance': "Activate scanner to verify your identity and log your attendance.",
    'screen-register': "Enroll new student details and capture face datasets for training.",
    'screen-students': "Manage registered students database and delete face datasets.",
    'screen-history': "Search and browse historical attendance logs.",
    'screen-admin': "Perform system maintenance, retrain recognition engine, and update access credentials."
};

// Toast notification
function showToast(title, message, isError = false) {
    const toast = document.getElementById('toast');
    const toastTitle = document.getElementById('toast-title');
    const toastMsg = document.getElementById('toast-message');
    
    toastTitle.innerText = title;
    toastMsg.innerText = message;
    
    if (isError) {
        toast.classList.add('error');
    } else {
        toast.classList.remove('error');
    }
    
    toast.classList.remove('hide');
    
    setTimeout(() => {
        toast.classList.add('hide');
    }, 4000);
}

// Speak text using SpeechSynthesis
function speakName(name) {
    const chkAudio = document.getElementById('chk-audio');
    if (!chkAudio.checked) return;
    
    if ('speechSynthesis' in window) {
        // Cancel any pending speech first
        window.speechSynthesis.cancel();
        
        const utterance = new SpeechSynthesisUtterance(`${name}, attendance marked`);
        utterance.rate = 0.95;
        utterance.pitch = 1.0;
        window.speechSynthesis.speak(utterance);
    }
}

// Format Clock & Date
function initClock() {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    setInterval(() => {
        const now = new Date();
        const hr = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const sec = String(now.getSeconds()).padStart(2, '0');
        txtClock.innerText = `${hr}:${min}:${sec}`;
        
        const day = now.getDate();
        const month = months[now.getMonth()];
        const year = now.getFullYear();
        txtDate.innerText = `${day} ${month} ${year}`;
    }, 500);
}

// Navigation Router
function initNavigation() {
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Stop any active webcam streams when switching screens
            stopAttendanceScanner();
            stopRegistrationScanner();
            
            // Toggle active menu class
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            
            // Toggle screen views
            const targetId = item.getAttribute('data-target');
            screens.forEach(s => {
                if (s.id === targetId) {
                    s.classList.add('active');
                } else {
                    s.classList.remove('active');
                }
            });
            
            // Update Title / Subtitle
            const title = item.querySelector('span').innerText;
            screenTitle.innerText = title;
            screenSubtitle.innerText = screenSubtitles[targetId] || "";
            
            // Load fresh data if dashboard or history is clicked
            if (targetId === 'screen-dashboard') {
                loadDashboardStats();
                loadTodayAttendance();
                if (!dashboardInterval) {
                    dashboardInterval = setInterval(() => {
                        const activeScreen = document.querySelector('.screen-view.active');
                        if (activeScreen && activeScreen.id === 'screen-dashboard') {
                            loadDashboardStats();
                            loadTodayAttendance();
                        }
                    }, 5000);
                }
            } else {
                if (dashboardInterval) {
                    clearInterval(dashboardInterval);
                    dashboardInterval = null;
                }
                if (targetId === 'screen-history') {
                    loadHistoryFileList();
                } else if (targetId === 'screen-students') {
                    loadRegisteredStudents();
                }
            }
        });
    });
}

// ----------------------------------------------------
// DASHBOARD ENDPOINTS
// ----------------------------------------------------
async function loadDashboardStats() {
    try {
        const response = await fetch(getBackendUrl() + '/api/stats');
        const data = await response.json();
        
        document.getElementById('stat-registered-count').innerText = data.registered_count;
        document.getElementById('stat-attendance-count').innerText = data.present_today;
        
        const absentCount = data.absent_count;
        document.getElementById('stat-absent-count').innerText = absentCount;
        document.getElementById('stat-absent-trend').innerText = absentCount === 1 ? "1 student missing" : `${absentCount} students missing`;
        
        const modelStateText = document.getElementById('stat-model-status');
        const modelStateSub = document.getElementById('stat-model-date');
        
        if (data.model_exists) {
            modelStateText.innerText = "Active";
            modelStateText.style.color = "#34d399";
            modelStateSub.innerText = "Trained model loaded";
        } else {
            modelStateText.innerText = "Missing";
            modelStateText.style.color = "#f87171";
            modelStateSub.innerText = "Train model in Admin tab";
        }
        
        const brainWrapper = document.getElementById('brain-wrapper');
        const trainStatusText = document.getElementById('txt-training-status');
        if (brainWrapper && trainStatusText) {
            if (data.model_exists) {
                brainWrapper.classList.remove('pulsing');
                trainStatusText.innerText = "Classifier model trained. Ready for scanning.";
            } else {
                brainWrapper.classList.add('pulsing');
                trainStatusText.innerText = "Warning: Trainer file missing. Please click Compile below.";
            }
        }
    } catch (err) {
        console.error("Error fetching stats:", err);
    }
}

async function loadTodayAttendance() {
    try {
        const response = await fetch(getBackendUrl() + '/api/attendance/today');
        const data = await response.json();
        
        const tbody = document.getElementById('tbody-today');
        tbody.innerHTML = '';
        
        if (data.records.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No attendance recorded today.</td></tr>`;
            return;
        }
        
        data.records.forEach(rec => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${rec.id}</strong></td>
                <td>${rec.name}</td>
                <td>${rec.date}</td>
                <td><span class="log-time">${rec.time}</span></td>
                <td style="text-align: right;">
                    <button class="btn-danger btn-sm btn-delete-attendance" data-filename="Attendance_${rec.date}.csv" data-id="${rec.id}" data-time="${rec.time}" data-name="${rec.name}">
                        <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 2.5px; vertical-align: middle;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        Remove
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Add event listeners to delete buttons
        const deleteButtons = tbody.querySelectorAll('.btn-delete-attendance');
        deleteButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const filename = btn.getAttribute('data-filename');
                const id = btn.getAttribute('data-id');
                const time = btn.getAttribute('data-time');
                const name = btn.getAttribute('data-name');
                deleteAttendanceEntry(filename, id, time, name);
            });
        });
    } catch (err) {
        console.error("Error loading today attendance:", err);
    }
}

// ----------------------------------------------------
// SCANNERS (WEBCAM CAPTURING & WEBSOCKET)
// ----------------------------------------------------

// Start Attendance WebSocket and Webcam
async function startAttendanceScanner() {
    const video = document.getElementById('cam-video');
    const overlay = document.getElementById('cam-overlay');
    const loading = document.getElementById('cam-loading');
    const errorEl = document.getElementById('cam-error');
    const btnStart = document.getElementById('btn-start-scanner');
    const btnStop = document.getElementById('btn-stop-scanner');
    
    loading.classList.add('active');
    errorEl.classList.remove('active');
    
    overlay.width = FRAME_WIDTH;
    overlay.height = FRAME_HEIGHT;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: FRAME_WIDTH, height: FRAME_HEIGHT, facingMode: 'user' }
        });
        
        activeCamStream = stream;
        video.srcObject = stream;
        
        video.onloadedmetadata = () => {
            loading.classList.remove('active');
            btnStart.disabled = true;
            btnStop.disabled = false;
            
            // Connect WebSocket
            connectAttendanceWS();
        };
    } catch (err) {
        console.error("Camera access error:", err);
        loading.classList.remove('active');
        errorEl.classList.add('active');
        document.getElementById('cam-error-msg').innerText = "Webcam access denied or unavailable.";
    }
}

function stopAttendanceScanner() {
    const video = document.getElementById('cam-video');
    const btnStart = document.getElementById('btn-start-scanner');
    const btnStop = document.getElementById('btn-stop-scanner');
    
    if (attendanceInterval) {
        clearTimeout(attendanceInterval);
        attendanceInterval = null;
    }
    
    if (wsAttendance) {
        wsAttendance._sendNextFrame = null;
        if (wsAttendance.readyState === WebSocket.OPEN) {
            wsAttendance.close();
        }
        wsAttendance = null;
    }
    
    if (activeCamStream) {
        activeCamStream.getTracks().forEach(track => track.stop());
        activeCamStream = null;
    }
    
    video.srcObject = null;
    
    // Clear overlay
    const overlay = document.getElementById('cam-overlay');
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    
    btnStart.disabled = false;
    btnStop.disabled = true;
    document.getElementById('cam-loading').classList.remove('active');
}
 
function connectAttendanceWS() {
    const backend = getBackendUrl();
    let wsUrl;
    if (backend) {
        try {
            const url = new URL(backend);
            const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            wsUrl = `${protocol}//${url.host}/ws/attendance`;
        } catch (e) {
            console.error("Invalid Backend URL for WebSocket:", e);
            showToast("Configuration Error", "Invalid Backend URL configured.", true);
            stopAttendanceScanner();
            return;
        }
    } else {
        const loc = window.location;
        const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${loc.host}/ws/attendance`;
    }
    
    wsAttendance = new WebSocket(wsUrl);
    
    wsAttendance.onopen = () => {
        console.log("WebSocket Attendance connected.");
        startAttendanceCaptureLoop();
    };
    
    wsAttendance.onmessage = (event) => {
        const data = JSON.parse(event.data);
        drawFaceBoundingBoxes(data.faces);
        
        // Handle attendance logged message
        if (data.attendance_marked) {
            showToast("Present Marked!", `${data.marked_student.name} logged successfully.`);
            speakName(data.marked_student.name);
            addSessionScannedCard(data.marked_student, "marked");
        } else if (data.already_marked_alert) {
            showToast("Already Marked", `${data.marked_student.name} was already verified today.`, false);
            addSessionScannedCard(data.marked_student, "already");
        }
        
        // Trigger next frame capture after 60ms throttle delay
        if (wsAttendance && wsAttendance._sendNextFrame) {
            attendanceInterval = setTimeout(() => {
                if (wsAttendance && wsAttendance._sendNextFrame) {
                    wsAttendance._sendNextFrame();
                }
            }, 60);
        }
    };
    
    wsAttendance.onclose = () => {
        console.log("WebSocket Attendance closed.");
    };
    
    wsAttendance.onerror = (err) => {
        console.error("WS error:", err);
    };
}
 
function startAttendanceCaptureLoop() {
    const video = document.getElementById('cam-video');
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = FRAME_WIDTH;
    captureCanvas.height = FRAME_HEIGHT;
    const ctx = captureCanvas.getContext('2d');
    
    function captureNext() {
        if (wsAttendance && wsAttendance.readyState === WebSocket.OPEN && activeCamStream) {
            ctx.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
            const base64Data = captureCanvas.toDataURL('image/jpeg', 0.85); // High quality to preserve facial features for LBPH
            const base64Raw = base64Data.split(',')[1];
            wsAttendance.send(base64Raw);
        }
    }
    
    if (wsAttendance) {
        wsAttendance._sendNextFrame = captureNext;
        captureNext(); // Send first frame
    }
}

function drawFaceBoundingBoxes(faces) {
    const overlay = document.getElementById('cam-overlay');
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    
    if (!faces || faces.length === 0) return;
    
    faces.forEach(face => {
        // Choose color based on recognition status
        let strokeColor = "#fbbf24"; // Yellow for searching/unknown
        let statusTag = "Verifying...";
        
        if (face.status === 'marked') {
            strokeColor = "#10b981"; // Emerald for marked
            statusTag = face.name;
        } else if (face.status === 'already_marked') {
            strokeColor = "#6366f1"; // Indigo for already marked
            statusTag = `${face.name} (Already Marked)`;
        } else if (face.status === 'unknown') {
            strokeColor = "#ef4444"; // Red for unknown
            statusTag = "Unknown Profile";
        }
        
        // Draw Rounded Bounding Box
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 3;
        ctx.shadowColor = strokeColor;
        ctx.shadowBlur = 6;
        
        const r = 8; // rounded radius
        const x = FRAME_WIDTH - face.x - face.w; // Flip coordinate to match mirrored camera preview
        const y = face.y;
        const w = face.w;
        const h = face.h;
        
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.stroke();
        
        // Reset shadows for text
        ctx.shadowBlur = 0;
        
        // Draw Status Tag Label Background
        ctx.fillStyle = strokeColor;
        ctx.font = "bold 13px Outfit, sans-serif";
        const tagTextWidth = ctx.measureText(statusTag).width + 16;
        
        ctx.beginPath();
        ctx.roundRect(x, y - 28, tagTextWidth, 22, [4, 4, 0, 0]);
        ctx.fill();
        
        // Text inside tag
        ctx.fillStyle = "#ffffff";
        ctx.fillText(statusTag, x + 8, y - 12);
    });
}

function addSessionScannedCard(student, status) {
    const list = document.getElementById('session-scanned-list');
    
    // Remove empty state if present
    const empty = list.querySelector('.empty-session-log');
    if (empty) empty.remove();
    
    // Check if ID card already exists in list to avoid duplicates in list
    const existing = document.getElementById(`session-card-${student.id}`);
    if (existing) {
        existing.remove(); // Put it at top
    }
    
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    
    const card = document.createElement('div');
    card.id = `session-card-${student.id}`;
    card.className = `session-log-card ${status}`;
    
    card.innerHTML = `
        <div class="log-main">
            <h5>${student.name}</h5>
            <p>ID: ${student.id} | ${status === 'already' ? 'Already Verified' : 'Logged Present'}</p>
        </div>
        <div class="log-time">${timeStr}</div>
    `;
    
    list.insertBefore(card, list.firstChild);
}

// ----------------------------------------------------
// REGISTRATION FLOW
// ----------------------------------------------------
async function startRegistrationScanner() {
    const video = document.getElementById('reg-video');
    const loading = document.getElementById('reg-cam-loading');
    const instructions = document.getElementById('reg-cam-instructions');
    const overlay = document.getElementById('reg-progress-overlay');
    const btnCancel = document.getElementById('btn-cancel-register');
    const btnStart = document.getElementById('btn-start-register');
    
    const studentId = document.getElementById('reg-student-id').value.trim();
    const studentName = document.getElementById('reg-student-name').value.trim();
    const adminPassword = document.getElementById('reg-admin-password').value;
    
    // Inputs validation
    if (!studentId || isNaN(studentId)) {
        showToast("Invalid ID", "Please enter a valid numeric Student ID.", true);
        return;
    }
    
    if (!studentName || !/^[a-zA-Z\s]+$/.test(studentName)) {
        showToast("Invalid Name", "Student name must contain only letters and spaces.", true);
        return;
    }

    if (!adminPassword) {
        showToast("Password Required", "Please enter the admin password.", true);
        const alertBox = document.getElementById('reg-status-alert');
        alertBox.className = 'alert-box error';
        alertBox.innerHTML = `<p><strong>Error:</strong> Password Required: Please enter the admin password.</p>`;
        alertBox.classList.remove('hide');
        return;
    }
    
    // Verify Password first
    try {
        const response = await fetch(getBackendUrl() + '/api/verify-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPassword })
        });
        if (!response.ok) {
            const data = await response.json();
            showToast("Unauthorized", data.detail || "Incorrect admin password!", true);
            const alertBox = document.getElementById('reg-status-alert');
            alertBox.className = 'alert-box error';
            alertBox.innerHTML = `<p><strong>Error:</strong> ${data.detail || "Incorrect admin password!"}</p>`;
            alertBox.classList.remove('hide');
            return;
        }
    } catch (err) {
        console.error("Password verification failed:", err);
        showToast("Connection Error", "Could not verify password with server.", true);
        return;
    }

    // Hide previous error if verification succeeds
    const alertBox = document.getElementById('reg-status-alert');
    alertBox.classList.add('hide');

    loading.classList.add('active');
    instructions.classList.remove('active');
    overlay.classList.add('hide');
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: FRAME_WIDTH, height: FRAME_HEIGHT, facingMode: 'user' }
        });
        
        activeRegStream = stream;
        video.srcObject = stream;
        
        video.onloadedmetadata = () => {
            loading.classList.remove('active');
            overlay.classList.remove('hide');
            btnStart.classList.add('hide');
            btnCancel.classList.remove('hide');
            
            // Connect to websocket
            connectRegisterWS(studentId, studentName, adminPassword);
        };
    } catch (err) {
        console.error("Reg camera error:", err);
        loading.classList.remove('active');
        instructions.classList.add('active');
        showToast("Webcam Error", "Webcam could not be opened.", true);
    }
}

function stopRegistrationScanner() {
    const video = document.getElementById('reg-video');
    const btnStart = document.getElementById('btn-start-register');
    const btnCancel = document.getElementById('btn-cancel-register');
    const overlay = document.getElementById('reg-progress-overlay');
    const instructions = document.getElementById('reg-cam-instructions');
    
    if (registerInterval) {
        clearInterval(registerInterval);
        registerInterval = null;
    }
    
    if (wsRegister) {
        if (wsRegister.readyState === WebSocket.OPEN) {
            wsRegister.close();
        }
        wsRegister = null;
    }
    
    if (activeRegStream) {
        activeRegStream.getTracks().forEach(track => track.stop());
        activeRegStream = null;
    }
    
    video.srcObject = null;
    overlay.classList.add('hide');
    instructions.classList.add('active');
    btnStart.classList.remove('hide');
    btnCancel.classList.add('hide');
    
    // Reset inputs
    document.getElementById('reg-student-id').value = '';
    document.getElementById('reg-student-name').value = '';
    document.getElementById('reg-admin-password').value = '';
}

function connectRegisterWS(id, name, password) {
    const backend = getBackendUrl();
    let wsUrl;
    const params = `?id=${id}&name=${encodeURIComponent(name)}&password=${encodeURIComponent(password)}`;
    if (backend) {
        try {
            const url = new URL(backend);
            const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            wsUrl = `${protocol}//${url.host}/ws/register${params}`;
        } catch (e) {
            console.error("Invalid Backend URL for Registration WebSocket:", e);
            showToast("Configuration Error", "Invalid Backend URL configured.", true);
            stopRegistrationScanner();
            return;
        }
    } else {
        const loc = window.location;
        const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${loc.host}/ws/register${params}`;
    }
    
    wsRegister = new WebSocket(wsUrl);
    
    wsRegister.onopen = () => {
        console.log("WebSocket Registration connection established.");
        startRegisterFrameLoop();
    };
    
    wsRegister.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.status === 'capturing') {
            const count = data.count;
            const percent = Math.min(count, 100);
            
            // Update progress radial circle
            const progressCircle = document.getElementById('reg-progress-circle');
            const circumference = 2 * Math.PI * 40; // 251.2
            const offset = circumference - (percent / 100) * circumference;
            progressCircle.style.strokeDashoffset = offset;
            
            // Update text labels
            document.getElementById('reg-progress-percent').innerText = `${percent}%`;
            document.getElementById('reg-progress-counter').innerText = `${percent}/100`;
            
            const alertBox = document.getElementById('reg-status-alert');
            alertBox.classList.remove('hide', 'success', 'error');
            alertBox.innerHTML = `<p>Capturing: ${percent}% completed. Position your face inside the camera view.</p>`;
        }
        
        if (data.status === 'completed') {
            showToast("Registration Success", `Face profiles for ID: ${id} saved successfully!`);
            const alertBox = document.getElementById('reg-status-alert');
            alertBox.className = 'alert-box success';
            alertBox.innerHTML = `<p><strong>Success!</strong> Registration details saved successfully. Face images database populated.</p>`;
            
            stopRegistrationScanner();
            loadDashboardStats(); // update student counts
        }
        
        if (data.status === 'error') {
            showToast("Registration Error", data.message, true);
            const alertBox = document.getElementById('reg-status-alert');
            alertBox.className = 'alert-box error';
            alertBox.innerHTML = `<p><strong>Error:</strong> ${data.message}</p>`;
            
            stopRegistrationScanner();
        }
    };
    
    wsRegister.onclose = () => {
        console.log("WebSocket Registration connection closed.");
    };
    
    wsRegister.onerror = (err) => {
        console.error("WS registration error:", err);
    };
}

function startRegisterFrameLoop() {
    const video = document.getElementById('reg-video');
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = FRAME_WIDTH;
    captureCanvas.height = FRAME_HEIGHT;
    const ctx = captureCanvas.getContext('2d');
    
    registerInterval = setInterval(() => {
        if (wsRegister && wsRegister.readyState === WebSocket.OPEN && activeRegStream) {
            ctx.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
            const base64Data = captureCanvas.toDataURL('image/jpeg', 0.85);
            const base64Raw = base64Data.split(',')[1];
            wsRegister.send(base64Raw);
        }
    }, 120); // Capture frame every 120ms
}

// ----------------------------------------------------
// ATTENDANCE LOGS HISTORY SCREEN
// ----------------------------------------------------
async function loadHistoryFileList() {
    try {
        const response = await fetch(getBackendUrl() + '/api/attendance/history');
        const data = await response.json();
        
        const select = document.getElementById('history-file-select');
        select.innerHTML = '<option value="">-- Select Date --</option>';
        
        if (data.files.length === 0) {
            return;
        }
        
        data.files.forEach(file => {
            const opt = document.createElement('option');
            opt.value = file.filename;
            opt.innerText = file.date;
            select.appendChild(opt);
        });
    } catch (err) {
        console.error("Error loading files list:", err);
    }
}

async function loadHistoryRecords() {
    const select = document.getElementById('history-file-select');
    const filename = select.value;
    const tbody = document.getElementById('tbody-history');
    const btnDownload = document.getElementById('btn-export-history');
    
    if (!filename) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Select a date from the dropdown to load history logs.</td></tr>`;
        btnDownload.disabled = true;
        return;
    }
    
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state"><div class="spinner" style="margin: 0 auto; width: 24px; height: 24px; border-width: 2px;"></div></td></tr>`;
    
    try {
        const response = await fetch(getBackendUrl() + `/api/attendance/history?filename=${filename}`);
        const data = await response.json();
        
        tbody.innerHTML = '';
        
        if (data.records.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No attendance records found for this date.</td></tr>`;
            btnDownload.disabled = true;
            return;
        }
        
        data.records.forEach(rec => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${rec.id}</strong></td>
                <td>${rec.name}</td>
                <td>${rec.date}</td>
                <td><span class="log-time">${rec.time}</span></td>
                <td style="text-align: right;">
                    <button class="btn-danger btn-sm btn-delete-attendance" data-filename="${filename}" data-id="${rec.id}" data-time="${rec.time}" data-name="${rec.name}">
                        <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 2.5px; vertical-align: middle;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        Remove
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Add event listeners to delete buttons
        const deleteButtons = tbody.querySelectorAll('.btn-delete-attendance');
        deleteButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const filename = btn.getAttribute('data-filename');
                const id = btn.getAttribute('data-id');
                const time = btn.getAttribute('data-time');
                const name = btn.getAttribute('data-name');
                deleteAttendanceEntry(filename, id, time, name);
            });
        });
        
        btnDownload.disabled = false;
    } catch (err) {
        console.error("Error loading history logs:", err);
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state text-danger">Failed to fetch logs from the server.</td></tr>`;
        btnDownload.disabled = true;
    }
}

// Download Excel/CSV action
function downloadCSV() {
    const select = document.getElementById('history-file-select');
    const filename = select.value;
    if (!filename) return;
    
    window.open(getBackendUrl() + `/api/attendance/history?filename=${filename}&download=true`);
}

// Filter logs locally via Search Bar
function filterHistoryTable() {
    const query = document.getElementById('search-history').value.toLowerCase().trim();
    const rows = document.querySelectorAll('#table-history tbody tr');
    
    rows.forEach(row => {
        const cells = row.getElementsByTagName('td');
        if (cells.length < 4) return; // skip empty state row
        
        const id = cells[0].innerText.toLowerCase();
        const name = cells[1].innerText.toLowerCase();
        
        if (id.includes(query) || name.includes(query)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// Delete an attendance entry
async function deleteAttendanceEntry(filename, studentId, timeLogged, studentName) {
    if (!confirm(`Are you sure you want to remove the attendance log for "${studentName}" (ID: ${studentId}) at ${timeLogged}?`)) {
        return;
    }
    
    try {
        const response = await fetch(getBackendUrl() + `/api/attendance?filename=${encodeURIComponent(filename)}&student_id=${encodeURIComponent(studentId)}&time_logged=${encodeURIComponent(timeLogged)}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        
        if (response.ok) {
            showToast("Log Removed", data.message || "Attendance log removed successfully!");
            // Refresh lists dynamically depending on active screen
            const activeScreen = document.querySelector('.screen-view.active');
            if (activeScreen) {
                if (activeScreen.id === 'screen-dashboard') {
                    loadDashboardStats();
                    loadTodayAttendance();
                } else if (activeScreen.id === 'screen-history') {
                    loadHistoryRecords();
                }
            }
        } else {
            showToast("Failed to remove log", data.detail || "Error occurred.", true);
        }
    } catch (err) {
        console.error("Error deleting attendance log:", err);
        showToast("Error", "Network request failed.", true);
    }
}

// ----------------------------------------------------
// ADMIN ACTIONS
// ----------------------------------------------------
async function trainModel() {
    const overlay = document.getElementById('training-overlay');
    overlay.classList.remove('hide');
    
    try {
        const response = await fetch(getBackendUrl() + '/api/train', { method: 'POST' });
        const data = await response.json();
        
        if (response.ok) {
            showToast("Training Completed", data.message || "Model trained successfully!");
        } else {
            showToast("Training Failed", data.detail || "Error during model compilation.", true);
        }
    } catch (err) {
        console.error("Error compiling model:", err);
        showToast("Error", "Network request failed while training.", true);
    } finally {
        overlay.classList.add('hide');
        loadDashboardStats(); // reload to show 'Active' model status
    }
}

async function changeAdminPassword() {
    const oldPass = document.getElementById('admin-old-pass').value;
    const newPass = document.getElementById('admin-new-pass').value;
    const confirmPass = document.getElementById('admin-confirm-pass').value;
    const alertBox = document.getElementById('admin-alert-box');
    const btnSubmit = document.getElementById('btn-change-password');
    
    alertBox.classList.add('hide');
    
    if (newPass !== confirmPass) {
        alertBox.className = "alert-box error";
        alertBox.innerHTML = "<p>Passwords do not match!</p>";
        alertBox.classList.remove('hide');
        return;
    }
    
    btnSubmit.disabled = true;
    
    try {
        const response = await fetch(getBackendUrl() + '/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old_pass: oldPass, new_pass: newPass, confirm_pass: confirmPass })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            alertBox.className = "alert-box success";
            alertBox.innerHTML = `<p>${data.message}</p>`;
            document.getElementById('admin-old-pass').value = '';
            document.getElementById('admin-new-pass').value = '';
            document.getElementById('admin-confirm-pass').value = '';
            showToast("Success", "Security credentials modified.");
        } else {
            alertBox.className = "alert-box error";
            alertBox.innerHTML = `<p>${data.detail || 'Wrong password entered.'}</p>`;
        }
    } catch (err) {
        console.error("Error changing password:", err);
        alertBox.className = "alert-box error";
        alertBox.innerHTML = "<p>Request failed. Verify network connection.</p>";
    } finally {
        alertBox.classList.remove('hide');
        btnSubmit.disabled = false;
    }
}

async function resetSystemDatabase() {
    const passwordInput = document.getElementById('reset-admin-password');
    const password = passwordInput.value;
    const btnReset = document.getElementById('btn-reset-system');
    
    if (!password) {
        showToast("Password Required", "Please enter the admin password to reset.", true);
        return;
    }
    
    if (!confirm("CRITICAL WARNING: This will permanently delete all students, face sample datasets, trained models, and attendance logs. Are you sure you want to completely wipe the system?")) {
        return;
    }
    
    btnReset.disabled = true;
    
    try {
        const response = await fetch(getBackendUrl() + '/api/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showToast("System Reset Successful", data.message || "All database records have been deleted.");
            passwordInput.value = '';
            // Refresh stats and lists immediately
            loadDashboardStats();
            loadTodayAttendance();
        } else {
            showToast("Reset Failed", data.detail || "Error resetting database.", true);
        }
    } catch (err) {
        console.error("Error during reset request:", err);
        showToast("Network Error", "Could not complete reset request.", true);
    } finally {
        btnReset.disabled = false;
    }
}

// ----------------------------------------------------
// REGISTERED STUDENTS CONTROLS
// ----------------------------------------------------
async function loadRegisteredStudents() {
    const tbody = document.getElementById('tbody-students');
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state"><div class="spinner" style="margin: 0 auto; width: 24px; height: 24px; border-width: 2px;"></div></td></tr>`;
    
    try {
        const response = await fetch(getBackendUrl() + '/api/students');
        const data = await response.json();
        
        tbody.innerHTML = '';
        
        if (!data.students || data.students.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No registered students found. Register someone first!</td></tr>`;
            return;
        }
        
        data.students.forEach(student => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${student.serial}</td>
                <td><strong>${student.id}</strong></td>
                <td>${student.name}</td>
                <td style="text-align: right;">
                    <button class="btn-danger btn-sm btn-delete-student" data-id="${student.id}" data-name="${student.name}">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: middle;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                        Remove
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        // Add event listeners to delete buttons
        const deleteButtons = tbody.querySelectorAll('.btn-delete-student');
        deleteButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = btn.getAttribute('data-id');
                const name = btn.getAttribute('data-name');
                if (confirm(`Are you sure you want to remove student "${name}" (ID: ${id}) and delete all their training face images?`)) {
                    await deleteStudent(id);
                }
            });
        });
    } catch (err) {
        console.error("Error loading students list:", err);
        tbody.innerHTML = `<tr><td colspan="4" class="empty-state text-danger">Failed to fetch students from the server.</td></tr>`;
    }
}

async function deleteStudent(studentId) {
    try {
        const response = await fetch(getBackendUrl() + `/api/students/${studentId}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        
        if (response.ok) {
            showToast("Student Removed", data.message || "Student removed successfully!");
            loadRegisteredStudents();
            loadDashboardStats(); // reload stats to update student counts
        } else {
            showToast("Failed to remove student", data.detail || "Error occurred.", true);
        }
    } catch (err) {
        console.error("Error deleting student:", err);
        showToast("Error", "Network request failed while deleting student.", true);
    }
}

function filterStudentsTable() {
    const query = document.getElementById('search-students').value.toLowerCase().trim();
    const rows = document.querySelectorAll('#table-students tbody tr');
    
    rows.forEach(row => {
        const cells = row.getElementsByTagName('td');
        if (cells.length < 4) return; // skip empty state row
        
        const serial = cells[0].innerText.toLowerCase();
        const id = cells[1].innerText.toLowerCase();
        const name = cells[2].innerText.toLowerCase();
        
        if (serial.includes(query) || id.includes(query) || name.includes(query)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// ----------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    initClock();
    initNavigation();
    
    // Dashboard actions
    loadDashboardStats();
    loadTodayAttendance();
    if (!dashboardInterval) {
        dashboardInterval = setInterval(() => {
            const activeScreen = document.querySelector('.screen-view.active');
            if (activeScreen && activeScreen.id === 'screen-dashboard') {
                loadDashboardStats();
                loadTodayAttendance();
            }
        }, 5000);
    }
    
    // Quick train listener
    const quickTrain = document.getElementById('quick-train-btn');
    if (quickTrain) {
        quickTrain.addEventListener('click', trainModel);
    }
    
    // Attendance Camera buttons
    document.getElementById('btn-start-scanner').addEventListener('click', startAttendanceScanner);
    document.getElementById('btn-stop-scanner').addEventListener('click', stopAttendanceScanner);
    
    // Registration Form submit
    document.getElementById('form-registration').addEventListener('submit', (e) => {
        e.preventDefault();
        startRegistrationScanner();
    });
    document.getElementById('btn-cancel-register').addEventListener('click', stopRegistrationScanner);
    
    // History selection log load
    document.getElementById('history-file-select').addEventListener('change', loadHistoryRecords);
    document.getElementById('btn-refresh-history').addEventListener('click', loadHistoryFileList);
    document.getElementById('btn-export-history').addEventListener('click', downloadCSV);
    document.getElementById('search-history').addEventListener('input', filterHistoryTable);
    
    // Admin buttons
    document.getElementById('btn-train-model').addEventListener('click', trainModel);
    document.getElementById('form-change-password').addEventListener('submit', (e) => {
        e.preventDefault();
        changeAdminPassword();
    });
    document.getElementById('form-reset-system').addEventListener('submit', (e) => {
        e.preventDefault();
        resetSystemDatabase();
    });
    
    // Export Today Attendance
    document.getElementById('btn-export-today').addEventListener('click', () => {
        const now = new Date();
        const dateStr = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
        const filename = `Attendance_${dateStr}.csv`;
        window.open(getBackendUrl() + `/api/attendance/history?filename=${filename}&download=true`);
    });
    
    // Registered Students screen buttons
    const btnRefreshStudents = document.getElementById('btn-refresh-students');
    if (btnRefreshStudents) {
        btnRefreshStudents.addEventListener('click', loadRegisteredStudents);
    }
    const searchStudents = document.getElementById('search-students');
    if (searchStudents) {
        searchStudents.addEventListener('input', filterStudentsTable);
    }
    
    // Load and save dynamic backend URL config
    const backendInput = document.getElementById('backend-api-url');
    if (backendInput) {
        backendInput.value = localStorage.getItem('attendease_backend_url') || '';
    }
    const formBackend = document.getElementById('form-backend-config');
    if (formBackend) {
        formBackend.addEventListener('submit', (e) => {
            e.preventDefault();
            const val = backendInput.value.trim();
            if (val) {
                try {
                    new URL(val); // validate
                    localStorage.setItem('attendease_backend_url', val);
                    showToast("Configuration Saved", "Backend API endpoint set successfully.");
                } catch (err) {
                    showToast("Invalid URL", "Please enter a valid HTTP/HTTPS URL.", true);
                }
            } else {
                localStorage.removeItem('attendease_backend_url');
                showToast("Configuration Cleared", "Resetting to local host relative pathing.");
            }
            // Reload dashboard metrics to check connection
            loadDashboardStats();
        });
    }
});
