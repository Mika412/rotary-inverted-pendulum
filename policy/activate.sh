# Activates the venv and, on macOS, exposes libpython for the mjpython viewer.

if [ ! -f .venv/bin/activate ]; then
    echo ".venv is missing. Run 'uv sync' first" >&2
else
    . .venv/bin/activate
    if [ "$(uname)" = Darwin ]; then
        export DYLD_FALLBACK_LIBRARY_PATH="$(python -c 'import sysconfig; print(sysconfig.get_config_var("LIBDIR"))')${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
    fi
fi
