# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the OpenYak backend.

Build with:
    cd backend
    pyinstaller openyak.spec
"""

import os
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_all

block_cipher = None

# Collect packages that PyInstaller sometimes misses
uvicorn_datas, uvicorn_binaries, uvicorn_hiddenimports = collect_all('uvicorn')
wcmatch_datas, wcmatch_binaries, wcmatch_hiddenimports = collect_all('wcmatch')
croniter_datas, croniter_binaries, croniter_hiddenimports = collect_all('croniter')

# Resolve paths
backend_dir = os.path.abspath('.')
app_dir = os.path.join(backend_dir, 'app')
repo_root = os.path.abspath(os.path.join(backend_dir, '..'))
frontend_out = os.environ.get(
    'OPENYAK_FRONTEND_OUT',
    os.path.join(repo_root, 'frontend', 'out'),
)

# Data files to include.
#
# Every entry here is REQUIRED. If any source path is missing at build time,
# the spec aborts instead of silently shipping a broken bundle — that is how
# we ended up releasing 1.0.7 with no mobile PWA (frontend_out was never
# copied, /m returned 404 over the cloudflare tunnel). Never weaken this
# check; add a new required path if you need a new resource.
_required_datas = [
    # Agent prompt templates
    (os.path.join(app_dir, 'agent', 'prompts'), os.path.join('app', 'agent', 'prompts')),
    # Alembic migrations
    (os.path.join(backend_dir, 'alembic'), 'alembic'),
    (os.path.join(backend_dir, 'alembic.ini'), '.'),
    # Bundled data (skills, plugins, connectors)
    (os.path.join(app_dir, 'data'), os.path.join('app', 'data')),
    # Frontend static export — served by FastAPI at /m for the mobile PWA
    # when a phone connects through the cloudflare tunnel. Without this,
    # remote access is effectively broken even though the desktop UI works
    # (Tauri reads the frontend from its own resources).
    (frontend_out, 'frontend_out'),
]

_missing = [src for src, _ in _required_datas if not os.path.exists(src)]
if _missing:
    sys.stderr.write(
        '\n[openyak.spec] FATAL: required build inputs are missing:\n'
    )
    for p in _missing:
        sys.stderr.write(f'  - {p}\n')
    sys.stderr.write(
        '\nBuild the frontend (DESKTOP_BUILD=true next build) and make sure\n'
        'backend/alembic, backend/app/agent/prompts and backend/app/data all\n'
        'exist before running pyinstaller. Aborting so we never ship a\n'
        'half-baked bundle.\n'
    )
    raise SystemExit(1)

# Sanity-check that the frontend export actually contains the mobile entry
# point. A stale `frontend/out` from a non-desktop build would otherwise
# slip past the existence check above.
_mobile_entry = os.path.join(frontend_out, 'm.html')
_next_dir = os.path.join(frontend_out, '_next')
if not os.path.isfile(_mobile_entry) or not os.path.isdir(_next_dir):
    sys.stderr.write(
        f'\n[openyak.spec] FATAL: frontend export at {frontend_out} is incomplete.\n'
        f'Expected {_mobile_entry} and {_next_dir}/ to exist.\n'
        'Rebuild the frontend with DESKTOP_BUILD=true before packaging.\n'
    )
    raise SystemExit(1)

datas = list(_required_datas)

# Hidden imports — modules that PyInstaller can't detect automatically
hiddenimports = [
    # FastAPI and dependencies
    'uvicorn',
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'fastapi',
    'starlette',
    'pydantic',
    'pydantic_settings',

    # Database
    'sqlalchemy',
    'sqlalchemy.ext.asyncio',
    'aiosqlite',
    'alembic',

    # SSE
    'sse_starlette',

    # LLM
    'openai',
    'httpx',
    'tiktoken',
    'tiktoken_ext',
    'tiktoken_ext.openai_public',

    # Document processing
    'pypdf',
    'docx',
    'openpyxl',
    'pptx',
    'markdown',

    # PDF generation
    'xhtml2pdf',
    'reportlab',
    'reportlab.graphics.barcode',
    'reportlab.graphics.barcode.code128',
    'reportlab.graphics.barcode.code39',
    'reportlab.graphics.barcode.code93',
    'reportlab.graphics.barcode.common',
    'reportlab.graphics.barcode.eanbc',
    'reportlab.graphics.barcode.ecc200datamatrix',
    'reportlab.graphics.barcode.fourstate',
    'reportlab.graphics.barcode.lto',
    'reportlab.graphics.barcode.qr',
    'reportlab.graphics.barcode.usps',
    'reportlab.graphics.barcode.usps4s',
    'reportlab.graphics.barcode.widgets',

    # Data science
    'pandas',
    'numpy',
    'matplotlib',

    # QR code generation (lazy import in remote.py)
    'qrcode',
    'qrcode.image',
    'qrcode.image.pil',
    'qrcode.main',

    # Utilities
    'ulid',
    'aiofiles',
    'yaml',
    'anyio',
    'anyio._backends',
    'anyio._backends._asyncio',
    'wcmatch',
    'wcmatch.glob',
    'wcmatch.fnmatch',
    'wcmatch.pathlib',
    'croniter',

    # App modules
    'app.main',
    'app.config',
    'app.dependencies',
    'app.api',
    'app.api.router',
    'app.api.chat',
    'app.api.sessions',
    'app.api.messages',
    'app.api.models',
    'app.api.agents',
    'app.api.tools',
    'app.api.artifacts',
    'app.api.pdf',
    'app.api.files',
    'app.api.skills',
    'app.api.health',
    'app.session.processor',
    'app.session.llm',
    'app.session.manager',
    'app.session.compaction',
    'app.session.system_prompt',
    'app.session.title',
    'app.session.retry',
    'app.streaming.events',
    'app.streaming.manager',
    'app.models.base',
    'app.models.session',
    'app.models.message',
    'app.models.project',
    'app.models.todo',
    'app.agent.agent',
    'app.agent.permission',
    'app.provider.base',
    'app.provider.openrouter',
    'app.provider.openai_compat',
    'app.provider.registry',
    'app.tool.registry',
    'app.tool.context',
    'app.tool.builtin.read',
    'app.tool.builtin.write',
    'app.tool.builtin.edit',
    'app.tool.builtin.bash',
    'app.tool.builtin.code_execute',
    'app.tool.builtin.glob_tool',
    'app.tool.builtin.grep',
    'app.tool.builtin.artifact',
    'app.tool.builtin.question',
    'app.tool.builtin.todo',
    'app.tool.builtin.task',
    'app.tool.builtin.skill',
    'app.tool.builtin.web_fetch',
    'app.tool.builtin.web_search',
    'app.tool.builtin.plan',
    'app.tool.builtin.invalid',
    'app.skill.registry',
    'app.storage.database',
    'app.schemas',
]

a = Analysis(
    ['run.py'],
    pathex=[backend_dir],
    binaries=uvicorn_binaries + wcmatch_binaries + croniter_binaries,
    datas=datas + uvicorn_datas + wcmatch_datas + croniter_datas,
    hiddenimports=hiddenimports + uvicorn_hiddenimports + wcmatch_hiddenimports + croniter_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # ── Testing & dev ────────────────────────────────────────────
        'tkinter',
        'test',
        'unittest',
        'pytest',
        'pytest_asyncio',
        '_pytest',
        'IPython',
        'ipykernel',
        'notebook',
        'jupyterlab',

        # ── Deep Learning frameworks (~4.5 GB) ───────────────────────
        'torch',
        'torchvision',
        'torchaudio',
        'torch._C',
        'torch.cuda',
        'paddle',
        'paddlepaddle',

        # ── ML / NLP / CV libraries ──────────────────────────────────
        'transformers',
        'tokenizers',
        'huggingface_hub',
        'hf_xet',
        'safetensors',
        'datasets',
        'accelerate',
        'bitsandbytes',
        'onnxruntime',
        'onnx',
        'sklearn',
        'scikit-learn',
        'scipy',
        'spacy',
        'thinc',
        'blis',
        'cymem',
        'preshed',
        'murmurhash',
        'srsly',
        'wasabi',
        'langcodes',
        'catalogue',
        'confection',
        'weasel',
        'nltk',
        'gensim',
        'lightgbm',
        'xgboost',
        'catboost',
        'sympy',

        # ── Computer Vision ──────────────────────────────────────────
        'cv2',
        'opencv-python',
        'imageio',
        'imageio_ffmpeg',
        'skimage',
        'scikit-image',

        # ── Numba / LLVM ─────────────────────────────────────────────
        'numba',
        'llvmlite',

        # ── Arrow / Parquet (pulled by pandas but not needed at runtime)
        'pyarrow',

        # ── Audio / Video / Game ─────────────────────────────────────
        'pygame',
        'librosa',
        'soundfile',
        'pydub',
        'yt_dlp',

        # ── AWS SDK ──────────────────────────────────────────────────
        'botocore',
        'boto3',
        's3transfer',

        # ── gRPC / Proto ─────────────────────────────────────────────
        'grpc',
        'grpcio',
        'google.protobuf',

        # ── Heavy optional libs ──────────────────────────────────────
        'gradio',
        'altair',
        'plotly',
        'dash',
        'bokeh',
        'seaborn',
        'statsmodels',
        'psycopg2',
        'psycopg',
        'psycopg_binary',
        'redis',
        'celery',
        'dask',
        'distributed',
        'ray',
        'mlflow',
        'wandb',
        'tensorboard',
        'tensorflow',
        'keras',
        'flax',
        'jax',
        'jaxlib',
        'einops',
        'triton',
        'pdfplumber',
        'pdfminer',
        'camelot',
        'tabula',
        'fpdf2',
        'fpdf',

        # ── Crypto / misc pulled by yt-dlp ───────────────────────────
        'Crypto',
        'Cryptodome',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='openyak-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='openyak-backend',
)
