#!/usr/bin/env python3
"""Mock Anthropic-protocol provider for verifying the chat + learnings loop.

Streaming chat: echoes a canned answer mentioning the question.
Extraction call (non-streaming, system contains 'durable knowledge'):
returns two candidate learnings as JSON.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        system = body.get("system", "")
        if "durable knowledge" in system:
            # run-unique texts so the E2E script's dedupe assertion is
            # independent of leftovers from previous runs (same text = the
            # app's md5 dedupe skips the insert entirely)
            run = os.environ.get("E2E_RUN_ID", "manual")
            text = json.dumps([
                {"kind": "learning", "text": f"Checkout p95 latency spikes correlate with payment-api deploy events on weekdays. [e2e:{run}]"},
                {"kind": "fact", "text": f"The user considers checkout latency the most business-critical service metric. [e2e:{run}]"},
            ])
            resp = {"content": [{"type": "text", "text": "Sure! " + text}], "stop_reason": "end_turn"}
            self._send(json.dumps(resp))
            return
        # streaming chat answer
        q = ""
        for m in body.get("messages", []):
            if m.get("role") == "user":
                c = m.get("content")
                q = c if isinstance(c, str) else str(c)
        events = [
            {"type": "message_start", "message": {}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": f"Mock answer about: {q[:80]}"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for ev in events:
            self.wfile.write(f"event: {ev['type']}\ndata: {json.dumps(ev)}\n\n".encode())
        self.wfile.flush()

    def _send(self, s):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(s)))
        self.end_headers()
        self.wfile.write(s.encode())


HTTPServer(("127.0.0.1", 9099), H).serve_forever()
