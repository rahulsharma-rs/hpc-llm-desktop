#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/.hpc-llm/runtime}"
LLAMA_DIR="$APP_DIR/llama.cpp"
INSTALL_DIR="$APP_DIR/bin"

mkdir -p "$APP_DIR" "$INSTALL_DIR" "$APP_DIR/logs" "$APP_DIR/sessions" "$HOME/cheaha_llm_client/gguf_models"
module purge || true
module load shared rc-base
module load CMake/3.26.3-GCCcore-12.3.0
module load binutils/2.40-GCCcore-12.3.0
module load CUDA/12.1.1

if [[ -d "$LLAMA_DIR" ]] && ! (cd "$LLAMA_DIR" && git rev-parse --git-dir >/dev/null 2>&1); then
  backup_dir="${LLAMA_DIR}.invalid-$(date +%Y%m%d%H%M%S)"
  mv "$LLAMA_DIR" "$backup_dir"
fi

if [[ ! -d "$LLAMA_DIR/.git" ]]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
else
  (cd "$LLAMA_DIR" && git pull --ff-only)
fi

CUDA_ROOT="$(dirname "$(dirname "$(command -v nvcc)")")"
CUDA_STUB_DIR="$CUDA_ROOT/targets/x86_64-linux/lib/stubs"
cmake --fresh -S "$LLAMA_DIR" -B "$LLAMA_DIR/build-cuda" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_NATIVE=OFF \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES="60;61;80" \
  -DCMAKE_EXE_LINKER_FLAGS="-L$CUDA_STUB_DIR -lcuda"
cmake --build "$LLAMA_DIR/build-cuda" --config Release --target llama-server -j "${SLURM_CPUS_ON_NODE:-4}"
cp "$LLAMA_DIR/build-cuda/bin/llama-server" "$INSTALL_DIR/llama-server-cuda"
cp "$LLAMA_DIR/build-cuda/bin/"*.so* "$INSTALL_DIR/" 2>/dev/null || true
chmod +x "$INSTALL_DIR/llama-server-cuda"

cmake --fresh -S "$LLAMA_DIR" -B "$LLAMA_DIR/build-cpu" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_NATIVE=OFF \
  -DGGML_CUDA=OFF
cmake --build "$LLAMA_DIR/build-cpu" --config Release --target llama-server -j "${SLURM_CPUS_ON_NODE:-4}"
cp "$LLAMA_DIR/build-cpu/bin/llama-server" "$INSTALL_DIR/llama-server-cpu"
cp "$LLAMA_DIR/build-cpu/bin/"*.so* "$INSTALL_DIR/" 2>/dev/null || true
chmod +x "$INSTALL_DIR/llama-server-cpu"
ln -sfn "$INSTALL_DIR/llama-server-cpu" "$INSTALL_DIR/llama-server"

cat > "$APP_DIR/llama_state.json" <<JSON
{
  "installer": "electron/install_llama_server.sh",
  "status": "installed",
  "server_cpu": "$INSTALL_DIR/llama-server-cpu",
  "server_cuda": "$INSTALL_DIR/llama-server-cuda",
  "models_dir": "$HOME/cheaha_llm_client/gguf_models"
}
JSON
