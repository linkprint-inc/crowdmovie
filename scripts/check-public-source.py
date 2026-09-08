#!/usr/bin/env python3
"""Scan the publishable Git file set; print categories/locations, never matched values."""
from pathlib import Path
import ipaddress
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
files = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
errors = []
for name in sorted(set(files)):
    if not name:
        continue
    path = root / name
    if not path.exists():
        continue
    parts = Path(name).parts
    if any(p in {'.codex', '.claude', '.playwright-cli', 'node_modules', 'dist', 'output', 'artifacts', '__pycache__'} for p in parts):
        errors.append((name, 0, 'runtime artifact'))
    if (path.name.startswith('.env') and path.name != '.env.example') or path.name in {'auth.json', 'known_hosts'} or path.suffix in {'.env', '.pem', '.key', '.dump', '.log', '.mp4'}:
        errors.append((name, 0, 'private file type'))
    if path.is_symlink():
        errors.append((name, 0, 'symlink requires review'))
        continue
    try:
        content = path.read_text()
    except UnicodeError:
        if path.suffix.lower() not in {'.png', '.webp', '.ico', '.woff2'}:
            errors.append((name, 0, 'unreviewed binary type'))
        continue
    for line_no, line in enumerate(content.splitlines(), 1):
        rules = {
            'credential': r'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})',
            'private key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
            'personal home': r'/(?:Users|home)/[A-Za-z0-9_.-]+/',
            'JWT': r'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{16,}',
        }
        for category, expression in rules.items():
            if re.search(expression, line):
                errors.append((name, line_no, category))
        for candidate in re.findall(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])', line):
            try:
                address = ipaddress.ip_address(candidate)
            except ValueError:
                continue
            allowed = address.is_loopback or candidate == '0.0.0.0' or candidate.startswith('192.168.10.')
            allowed = allowed or (name.startswith('app/server/test/') and candidate.startswith('10.'))
            if not allowed:
                errors.append((name, line_no, 'non-example IPv4'))
        for candidate in re.findall(r'(?<![\w:])(?:[a-fA-F0-9]{0,4}:){2,}[a-fA-F0-9]{0,4}(?![\w:])', line):
            try:
                address = ipaddress.ip_address(candidate)
            except ValueError:
                continue
            if not address.is_loopback and not address.is_unspecified and not (name.startswith('app/server/test/') and candidate.startswith('fd00:')):
                errors.append((name, line_no, 'non-example IPv6'))
for name, line, category in errors:
    print(f'{name}:{line}: {category}')
print(f'Public-source scan: {len(set(filter(None, files)))} files, {len(errors)} findings')
sys.exit(bool(errors))
