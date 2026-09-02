# -*- coding: utf-8 -*-
"""V4.2.11 鸭梨山大 E2E 数据层助手（仅 E2E 测试调用；不进任何发布产物）。

职责：vitest（Node，无 SQLite）↔ app.db / tasks.json / images.json 的读写桥。
写入语义镜像 src-tauri/src/storage.rs：kv_store 为权威存储，旧 *.json 文件
存在时双写镜像（只写已存在的文件，不新建）。

用法（全部输出 JSON 到 stdout，绝不读写任何令牌）：
  python db_helper.py dump-project <project_id>
  python db_helper.py write-project <project_id> <stage> <record_json_file>
  python db_helper.py read-tasks
  python db_helper.py append-tasks <tasks_array_json_file>
  python db_helper.py append-images <images_array_json_file>
  python db_helper.py read-images
  python db_helper.py settings
"""

import io
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone, timedelta

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DATA_DIR = os.path.join(os.environ['APPDATA'], 'com.gptimage.batch-generator')
DB_PATH = os.path.join(DATA_DIR, 'app.db')
TZ = timezone(timedelta(hours=8))


def now_rfc3339() -> str:
    return datetime.now(TZ).isoformat()


def connect():
    return sqlite3.connect(DB_PATH, timeout=15)


def kv_read(conn, key):
    row = conn.execute('SELECT value_json FROM kv_store WHERE key = ?', (key,)).fetchone()
    if row:
        return json.loads(row[0])
    legacy = {'tasks': 'tasks.json', 'images': 'images.json'}.get(key)
    if legacy and os.path.exists(os.path.join(DATA_DIR, legacy)):
        return json.load(open(os.path.join(DATA_DIR, legacy), encoding='utf-8'))
    return None


def kv_write(conn, key, value):
    conn.execute(
        'INSERT OR REPLACE INTO kv_store (key, value_json, updated_at) VALUES (?, ?, ?)',
        (key, json.dumps(value, ensure_ascii=False), now_rfc3339()),
    )
    legacy = {'tasks': 'tasks.json', 'images': 'images.json'}.get(key)
    if legacy and os.path.exists(os.path.join(DATA_DIR, legacy)):
        with open(os.path.join(DATA_DIR, legacy), 'w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False)


def cmd_dump_project(project_id):
    conn = connect()
    row = conn.execute(
        'SELECT stage, data_json, updated_at, last_opened_at FROM comic_projects WHERE id = ?',
        (project_id,),
    ).fetchone()
    conn.close()
    if not row:
        print(json.dumps({'ok': False, 'error': 'project not found'}))
        return
    print(json.dumps({
        'ok': True,
        'stage': row[0],
        'record': json.loads(row[1]),
        'updated_at': row[2],
        'last_opened_at': row[3],
    }, ensure_ascii=False))


def cmd_write_project(project_id, stage, record_file):
    record = json.load(open(record_file, encoding='utf-8'))
    conn = connect()
    conn.execute(
        'UPDATE comic_projects SET stage = ?, data_json = ?, updated_at = ?, last_opened_at = ? WHERE id = ?',
        (stage, json.dumps(record, ensure_ascii=False), now_rfc3339(), now_rfc3339(), project_id),
    )
    changed = conn.total_changes
    conn.commit()
    conn.close()
    print(json.dumps({'ok': changed > 0, 'rows': changed}))


def cmd_read(kind):
    conn = connect()
    value = kv_read(conn, kind)
    conn.close()
    print(json.dumps({'ok': value is not None, kind: value if value is not None else []}, ensure_ascii=False))


def cmd_append(kind, payload_file):
    incoming = json.load(open(payload_file, encoding='utf-8'))
    if not isinstance(incoming, list):
        incoming = [incoming]
    conn = connect()
    existing = kv_read(conn, kind) or []
    if isinstance(existing, dict):
        existing = existing.get(kind, [])
    by_id = {item.get('id'): item for item in existing}
    merged = list(existing)
    for item in incoming:
        if item.get('id') in by_id:
            merged = [row if row.get('id') != item.get('id') else item for row in merged]
        else:
            merged.append(item)
    kv_write(conn, kind, merged)
    conn.commit()
    conn.close()
    print(json.dumps({'ok': True, 'before': len(existing), 'after': len(merged)}))


def cmd_settings():
    value = kv_read(connect(), 'settings') or {}
    print(json.dumps({
        'ok': True,
        'server_url': value.get('server_url'),
        'library_input_dir': value.get('library_input_dir'),
        'default_output_dir': value.get('default_output_dir'),
    }, ensure_ascii=False))


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({'ok': False, 'error': 'missing command'}))
        return
    command, rest = args[0], args[1:]
    if command == 'dump-project':
        cmd_dump_project(rest[0])
    elif command == 'write-project':
        cmd_write_project(rest[0], rest[1], rest[2])
    elif command in ('read-tasks', 'read-images'):
        cmd_read('tasks' if command == 'read-tasks' else 'images')
    elif command == 'append-tasks':
        cmd_append('tasks', rest[0])
    elif command == 'append-images':
        cmd_append('images', rest[0])
    elif command == 'settings':
        cmd_settings()
    else:
        print(json.dumps({'ok': False, 'error': f'unknown command {command}'}))


if __name__ == '__main__':
    main()
