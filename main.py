import uvicorn
import socket

def find_available_port(start_port=8000, host="0.0.0.0"):
    port = start_port
    # Try common ports first, then sequential scan
    ports_to_try = [8000, 8080, 8081, 5000, 8001] + list(range(start_port, start_port + 100))
    for p in ports_to_try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, p))
                return p
            except OSError:
                continue
    return start_port

if __name__ == "__main__":
    print("Starting modern Attendease Web Server...")
    port = find_available_port()
    print(f"Navigate to: http://localhost:{port}")
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)