"""
Запуск ігрового порталу КОІНЗАЛ.
Просто натисни Run у PyCharm (або виконай: python server.py) —
сервер підніметься і сайт сам відкриється в браузері.
"""
import http.server
import socketserver
import webbrowser
import os
import threading

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)


def open_browser():
    webbrowser.open(f"http://localhost:{PORT}/index.html")


if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Сервер запущено: http://localhost:{PORT}/index.html")
        print("Щоб зупинити — натисни Ctrl+C у консолі PyCharm.")
        threading.Timer(0.8, open_browser).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nСервер зупинено.")