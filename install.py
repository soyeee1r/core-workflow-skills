#!/usr/bin/env python3
"""Install one packaged skill without replacing an existing installation."""
import argparse
import os
from pathlib import Path
import shutil

SKILLS = ('douyin-comment-collector', 'summarize-x-content', 'collect-content-performance-data', 'manage-personal-work-reports')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('skill', choices=SKILLS)
    parser.add_argument('--destination', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'skills')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent / args.skill
    target = args.destination.expanduser() / args.skill
    if target.exists() or target.is_symlink():
        parser.error(f'Existing skill was not changed: {target}')
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    print(f'Installed {args.skill} to {target}; no automation or external actions started.')

if __name__ == '__main__':
    main()
