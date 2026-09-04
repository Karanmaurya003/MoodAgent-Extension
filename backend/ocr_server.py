import base64
import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageOps
import pytesseract


HOST = os.getenv("MOODAGENT_OCR_HOST", "127.0.0.1")
PORT = int(os.getenv("MOODAGENT_OCR_PORT", "8765"))
TESSERACT_CANDIDATES = [
    os.getenv("TESSERACT_CMD", "").strip(),
    r"D:\Setup\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
]


def resolve_tesseract_cmd():
    for candidate in TESSERACT_CANDIDATES:
      if candidate and os.path.exists(candidate):
        return candidate
    return None


def decode_data_url(data_url: str):
    if not data_url or "," not in data_url:
        return None
    _, encoded = data_url.split(",", 1)
    try:
        return base64.b64decode(encoded)
    except Exception:
        return None


def sanitize_text(text: str) -> str:
    return " ".join((text or "").replace("\r", "\n").split())


def ocr_image(data_url: str):
    tesseract_cmd = resolve_tesseract_cmd()
    if not tesseract_cmd:
        return {"status": "error", "text": "", "reason": "tesseract_not_found"}

    raw = decode_data_url(data_url)
    if not raw:
        return {"status": "error", "text": "", "reason": "invalid_image_data"}

    try:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        image = Image.open(io.BytesIO(raw)).convert("L")
        image = ImageOps.autocontrast(image)
        text = pytesseract.image_to_string(image, config="--psm 6")
        return {"status": "ok", "text": sanitize_text(text)}
    except Exception as exc:
        return {"status": "error", "text": "", "reason": str(exc)}


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send_json(200, {"status": "ok"})

    def do_GET(self):
        if self.path != "/health":
            self._send_json(404, {"status": "error", "reason": "not_found"})
            return
        self._send_json(200, {"status": "ok", "tesseract": bool(resolve_tesseract_cmd())})

    def do_POST(self):
        if self.path != "/ocr":
            self._send_json(404, {"status": "error", "reason": "not_found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"

        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json(400, {"status": "error", "reason": "invalid_json"})
            return

        result = ocr_image(payload.get("imageDataUrl", ""))
        self._send_json(200, result)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"MoodAgent OCR server listening on http://{HOST}:{PORT}")
    server.serve_forever()
