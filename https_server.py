#!/usr/bin/env python3
"""
HTTPS開発サーバー（自己署名証明書）
カメラAPIのテスト用
"""

import http.server
import ssl
import os
import sys

# サーバー設定
HOST = '0.0.0.0'  # すべてのインターフェースでリッスン
PORT = 8443       # HTTPSポート

# 証明書を生成（初回のみ）
if not os.path.exists('server.pem'):
    print('自己署名証明書を生成中...')
    
    # OpenSSLで証明書生成を試みる
    try:
        import subprocess
        result = subprocess.run([
            'openssl', 'req', '-new', '-x509', '-keyout', 'server.pem', '-out', 'server.pem',
            '-days', '365', '-nodes', '-subj', '/CN=localhost'
        ], capture_output=True, text=True, check=True)
        print('証明書を生成しました: server.pem')
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        print('OpenSSLが見つかりません。Pythonで証明書を生成します...')
        
        # Pythonの標準ライブラリで証明書を生成（OpenSSL不要）
        try:
            from cryptography import x509
            from cryptography.x509.oid import NameOID
            from cryptography.hazmat.primitives import hashes
            from cryptography.hazmat.primitives.asymmetric import rsa
            from cryptography.hazmat.primitives import serialization
            from datetime import datetime, timedelta, timezone
            import ipaddress
            
            # 秘密鍵を生成
            private_key = rsa.generate_private_key(
                public_exponent=65537,
                key_size=2048,
            )
            
            # 証明書を生成
            subject = issuer = x509.Name([
                x509.NameAttribute(NameOID.COUNTRY_NAME, u"JP"),
                x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, u"Tokyo"),
                x509.NameAttribute(NameOID.LOCALITY_NAME, u"Tokyo"),
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, u"Local Dev"),
                x509.NameAttribute(NameOID.COMMON_NAME, u"localhost"),
            ])
            
            cert = x509.CertificateBuilder().subject_name(
                subject
            ).issuer_name(
                issuer
            ).public_key(
                private_key.public_key()
            ).serial_number(
                x509.random_serial_number()
            ).not_valid_before(
                datetime.now(timezone.utc)
            ).not_valid_after(
                datetime.now(timezone.utc) + timedelta(days=365)
            ).add_extension(
                x509.SubjectAlternativeName([
                    x509.DNSName(u"localhost"),
                    x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                ]),
                critical=False,
            ).sign(private_key, hashes.SHA256())
            
            # PEM形式で保存
            with open('server.pem', 'wb') as f:
                f.write(private_key.private_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PrivateFormat.TraditionalOpenSSL,
                    encryption_algorithm=serialization.NoEncryption()
                ))
                f.write(cert.public_bytes(serialization.Encoding.PEM))
            
            print('証明書を生成しました: server.pem')
            
        except ImportError:
            print('\n【エラー】証明書の生成に失敗しました。')
            print('\n以下のいずれかの方法で解決してください：')
            print('\n方法1: cryptographyライブラリをインストール（推奨）')
            print('  pip install cryptography')
            print('\n方法2: OpenSSLをインストール')
            print('  Windowsの場合: https://slproweb.com/products/Win32OpenSSL.html')
            print('  またはChocolatey: choco install openssl')
            print('\n方法3: 既存の証明書を使用')
            print('  server.pemファイルをプロジェクトフォルダに配置してください')
            print('\nインストール後、再度 python https_server.py を実行してください。')
            sys.exit(1)

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
