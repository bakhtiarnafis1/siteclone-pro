"""SiteClone local preview server (Python 3, no packages needed).

Serves this folder at http://localhost:<port> so ES modules, fetch(), WebGL/3D, fonts and
service workers behave like on the real website (browsers block many of them on file://).
"""
import functools
import http.server
import mimetypes
import os
import socketserver
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for ext, typ in {'.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm',
                 '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.woff2': 'font/woff2',
                 '.avif': 'image/avif', '.webp': 'image/webp', '.svg': 'image/svg+xml'}.items():
    mimetypes.add_type(typ, ext)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def send_head(self):
        # "/about" -> "/about.html" when that file exists
        path = self.translate_path(self.path)
        if not os.path.exists(path) and os.path.isfile(path + '.html'):
            self.path = self.path.split('?')[0] + '.html'
        return super().send_head()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


handler = functools.partial(Handler, directory=ROOT)
for port in range(8080, 8100):
    try:
        httpd = Server(('127.0.0.1', port), handler)
        break
    except OSError:
        continue
else:
    raise SystemExit('No free port between 8080 and 8099.')

url = f'http://localhost:{port}/'
print(f'\n  Your website copy is running at {url}')
print('  Keep this window open while you browse. Close it to stop.\n')
webbrowser.open(url)
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    pass
