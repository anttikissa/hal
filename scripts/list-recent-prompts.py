#!/usr/bin/env python3
import argparse
import glob
import os
import re
import time
from datetime import datetime


def family(model: str) -> str:
	m = (model or '').lower()
	if 'claude' in m:
		return 'claude'
	if 'codex' in m:
		return 'codex'
	return m.split('/')[0] if m else 'unknown'


def tilde(path: str, home: str) -> str:
	if not path:
		return '~'
	if path.startswith(home):
		return '~' + path[len(home):]
	return path


def parse_ason_records(text: str):
	records = []
	for chunk in re.findall(r'\{[\s\S]*?\}', text):
		pairs = re.findall(r"(\w+)\s*:\s*('(?:\\'|[^'])*'|\"(?:\\\"|[^\"])*\")\s*,?", chunk)
		if not pairs:
			continue
		rec = {}
		for k, raw in pairs:
			if raw.startswith("'") and raw.endswith("'"):
				v = raw[1:-1].replace("\\'", "'")
			elif raw.startswith('"') and raw.endswith('"'):
				v = raw[1:-1].replace('\\"', '"')
			else:
				v = raw
			rec[k] = v
		records.append(rec)
	return records


def parse_ts(value: str, fallback: float) -> datetime:
	if not value:
		return datetime.fromtimestamp(fallback)
	v = value.strip().replace('Z', '+00:00')
	try:
		return datetime.fromisoformat(v)
	except Exception:
		return datetime.fromtimestamp(fallback)


def collect(session_root: str, hours: int):
	cutoff = time.time() - hours * 3600
	files = []
	for p in glob.glob(os.path.join(session_root, 's-*', 'prompts.ason')):
		try:
			st = os.stat(p)
		except FileNotFoundError:
			continue
		if st.st_mtime >= cutoff:
			files.append((p, st.st_mtime))

	rows = []
	home = os.path.expanduser('~')
	for p, mtime in files:
		with open(p, 'r', encoding='utf-8') as f:
			text = f.read()
		records = parse_ason_records(text)
		for r in records:
			prompt = (r.get('prompt') or '').strip()
			if not prompt:
				continue
			dt = parse_ts(r.get('timestamp', ''), mtime)
			model = family(r.get('model') or r.get('provider') or '')
			cwd = tilde(r.get('cwd') or os.path.dirname(os.path.dirname(p)), home)
			prompt_one_line = ' '.join(prompt.split())
			rows.append((dt, model, cwd, prompt_one_line))

	rows.sort(key=lambda x: x[0])
	return rows


def main():
	parser = argparse.ArgumentParser(description='List recent prompts from HAL session logs')
	parser.add_argument('--hours', type=int, default=72, help='Look back window in hours (default: 72)')
	parser.add_argument('--sessions', default=os.path.expanduser('~/.hal/state/sessions'), help='Sessions root dir')
	args = parser.parse_args()

	for dt, model, cwd, prompt in collect(args.sessions, args.hours):
		print(f"{model} {dt.strftime('%Y-%m-%d %H:%M')} {cwd}> {prompt}")


if __name__ == '__main__':
	main()
