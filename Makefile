.PHONY: help install install-dev update dev agent frontend extension clean

# Prefer uv (https://github.com/astral-sh/uv) — ~10× faster than pip.
# Falls back to stdlib venv + pip when uv is not installed.
HAS_UV := $(shell command -v uv 2>/dev/null)
# venv lives on the system disk so launchd can spawn it without hitting
# macOS sandbox EPERM on fresh files written to external volumes. Override
# with: make install VENV=/some/other/path
VENV ?= $(HOME)/.flowboard/agent-venv

help:
	@echo "Flowboard dev commands:"
	@echo "  make install      - install runtime deps (agent + frontend). venv at $(VENV)"
	@echo "  make install-dev  - install agent with dev extras (ruff, pytest)"
	@echo "  make update       - upgrade existing deps (agent + frontend)"
	@echo "  make dev          - hint: run agent + frontend in separate terminals"
	@echo "  make agent        - run agent only (FastAPI on :8101)"
	@echo "  make frontend     - run frontend only (Vite on :5173)"
	@echo "  make extension    - package extension (unpacked: load from ./extension)"
	@echo "  make clean        - remove build + cache"

install:
ifdef HAS_UV
	cd agent && uv venv $(VENV) && uv pip install --python $(VENV)/bin/python -e .
else
	cd agent && python -m venv $(VENV) && $(VENV)/bin/pip install -e .
endif
	cd frontend && npm install

install-dev:
ifdef HAS_UV
	cd agent && uv venv $(VENV) && uv pip install --python $(VENV)/bin/python -e ".[dev]"
else
	cd agent && python -m venv $(VENV) && $(VENV)/bin/pip install -e ".[dev]"
endif
	cd frontend && npm install

update:
ifdef HAS_UV
	cd agent && uv pip install --python $(VENV)/bin/python -U -e .
else
	cd agent && $(VENV)/bin/pip install -U -e .
endif
	cd frontend && npm update

# Two dev modes. Pick one based on what you're doing:
#
#   make dev-loopback   foreground agent (with --reload) + stop the service
#                       so it owns port 8101. Press Ctrl+C to stop dev; the
#                       service auto-restarts. (Implemented in bin/flowboard.)
#
#   make dev-parallel   keep the service running for backend, run Vite
#                       separately for HMR on the React side. Best when
#                       you only edit frontend/src.
#
# In both cases, the Chrome extension (./extension) is unchanged — reload
# it manually from chrome://extensions after editing extension/*.js.
dev: dev-loopback

dev-loopback:
	bash bin/flowboard dev

dev-parallel:
	@echo "Service is still running in background. Open a 2nd terminal:"
	@echo "  cd frontend && npm run dev"
	@echo "Then visit http://localhost:5173 (Vite proxies /api -> :8101).

agent:
	cd agent && $(VENV)/bin/uvicorn flowboard.main:app --reload --port 8101

frontend:
	cd frontend && npm run dev

clean:
	rm -rf $(VENV) agent/.venv agent/**/__pycache__ frontend/node_modules frontend/dist

# ── Background service (macOS launchd) ─────────────────────────────────────
# Builds the frontend, then installs + starts a per-user LaunchAgent that
# runs the agent on :8101 and auto-restarts on crash / login.
.PHONY: service-install service-uninstall service-status service-logs service-restart frontend-build

frontend-build:
	cd frontend && npm run build

service-install: frontend-build
	bash bin/flowboard install

service-uninstall:
	bash bin/flowboard uninstall

service-start:    ; bash bin/flowboard start
service-stop:     ; bash bin/flowboard stop
service-restart:  ; bash bin/flowboard restart
service-status:   ; bash bin/flowboard status
service-logs:     ; bash bin/flowboard logs

service-help:
	@echo "make service-install    one-time setup: builds FE + loads LaunchAgent"
	@echo "make service-status     is the agent running? tail of logs"
	@echo "make service-logs       live tail stdout+stderr"
	@echo "make service-restart    after editing agent/ code"
	@echo "make service-stop       unload but keep plist"
	@echo "make service-uninstall  remove plist + unload"
