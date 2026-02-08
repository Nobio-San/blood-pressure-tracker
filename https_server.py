#!/usr/bin/env python3
"""
HTTPS開発サーバー（自己署名証明書）
カメラAPIのテスト用
"""

import http.server
import ssl
import os

# サーバー設定
HOST = '0.0.0.0'  # すべてのインターフェースでリッスン
PORT = 8443       # HTTPSポート

# 証明書を生成（初回のみ）
if not os.path.exists('server.pem'):
    print('自己署名証明書を生成中...')
    import subprocess
    subprocess.run([
        'openssl', 'req', '-new', '-x509', '-keyout', 'server.pem', '-out', 'server.pem',
        '-days', '365', '-nodes', '-subj', '/CN=localhost'
    ])
    print('証明書を生成しました: server.pem')

# HTTPSサーバーの起動
print(f'HTTPSサーバーを起動: https://{HOST}:{PORT}')
print(f'ローカル: https://localhost:{PORT}')
print(f'ネットワーク: https://192.168.10.103:{PORT}')
print('\n警告: 自己署名証明書のため、ブラウザで警告が表示されます')
print('「詳細設定」→「安全でないサイトに進む」をクリックしてください\n')

server_address = (HOST, PORT)
httpd = http.server.HTTPServer(server_address, http.server.SimpleHTTPRequestHandler)

# SSL設定
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('server.pem')
httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

print('Ctrl+C で停止')
httpd.serve_forever()
