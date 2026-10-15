"""Frozen GUI and stdio entry; no shell, environment key lookup or web bridge."""
from pathlib import Path
import sys
sys.dont_write_bytecode = True
if not getattr(sys, 'frozen', False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from human_ui import main
raise SystemExit(main())
