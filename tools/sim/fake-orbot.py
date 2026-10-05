#!/usr/bin/env python3
"""Stand-in for Orbot's local API on 127.0.0.1:15182: /info reports Orbot
started with a bypass port. Usage: fake-orbot.py BYPASSPORT LOGFILE"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer

BYPASS = int(sys.argv[1]); LOG = open(sys.argv[2], 'a', buffering=1)

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        LOG.write('%s GET %s token=%s\n' % (time.strftime('%H:%M:%S'), self.path, self.headers.get('X-Token')))
        if self.path != '/info':
            self.send_response(404); self.end_headers(); return
        body = json.dumps({'status': 'started', 'onionOnly': False, 'bypassPort': BYPASS}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

HTTPServer(('127.0.0.1', 15182), H).serve_forever()
