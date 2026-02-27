# lsc (llama-server-cli)

CLI and TUI for managing `llama.cpp` server: download models, generate presets, and start/stop servers.

## Features

- TUI for model management and presets
- Download manager with resume support
- Preset-based server launch
- Optional request logging proxy

## Requirements

- Node.js 18+ (recommended)
- Git
- CMake + C/C++ toolchain for building `llama.cpp`

## Install (local dev)

```bash
git clone <your-repo-url>
cd llama-server-cli
npm install
npm run build
npm link
```

After linking, the `lsc` command should be available in your shell.

## Quick Start

```bash
# Launch TUI
lsc

# Or start a model directly
lsc start --model /path/to/model.gguf
```

## Configuration

Config file is stored at:

```
~/.config/lsc/config.json
```

Common settings you may want to adjust:

- `modelsDir`: directory where models are stored
- `llamaServerPath`: path to the `llama-server` binary

## AI Agent Installation Instructions

This section is specifically for AI agents. Follow these steps to install from scratch on a clean machine.

### 1) Install system dependencies

Pick the section for your OS.

#### Ubuntu/Debian

```bash
sudo apt-get update
sudo apt-get install -y git cmake build-essential python3 curl
```

#### macOS (Homebrew)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git cmake
```

#### Windows (PowerShell, winget)

```powershell
winget install Git.Git
winget install Kitware.CMake
winget install Microsoft.VisualStudio.2022.BuildTools
```

Make sure the C++ build tools are installed in Visual Studio Build Tools (C++ workload).

### 2) Install Node.js 18+

#### Ubuntu/Debian

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

#### macOS (Homebrew)

```bash
brew install node@18
node -v
npm -v
```

#### Windows (PowerShell, winget)

```powershell
winget install OpenJS.NodeJS.LTS
node -v
npm -v
```

### 3) Check environment and pick a backend

Goal: decide CPU vs GPU build for `llama.cpp`.

#### Quick checks

- NVIDIA GPU present: `nvidia-smi`
- AMD GPU on Linux (ROCm): `rocminfo`
- Apple Silicon (Metal): `uname -m` returns `arm64`

If none of the above apply, use the CPU build.

#### Backend choice

- CPU: most compatible, slowest
- CUDA: NVIDIA GPUs
- ROCm: AMD GPUs on Linux
- Metal: Apple Silicon

### 4) Build and install llama.cpp

```bash
git clone https://github.com/ggerganov/llama.cpp.git
cd llama.cpp

# CPU build
cmake -B build
cmake --build build -j
```

CUDA (NVIDIA) build:

```bash
cmake -B build -DGGML_CUDA=ON
cmake --build build -j
```

ROCm (AMD, Linux) build:

```bash
cmake -B build -DGGML_ROCM=ON
cmake --build build -j
```

Metal (Apple Silicon) build:

```bash
cmake -B build -DGGML_METAL=ON
cmake --build build -j
```

On Windows (PowerShell), use:

```powershell
git clone https://github.com/ggerganov/llama.cpp.git
cd llama.cpp
cmake -B build
cmake --build build --config Release -j
```

The `llama-server` binary will be at:

```
<llama.cpp>/build/bin/llama-server
```

On Windows, it will be:

```
<llama.cpp>\build\bin\Release\llama-server.exe
```

### 5) Clone and build this project

```bash
git clone <your-repo-url>
cd llama-server-cli
npm install
npm run build
npm link
```

### 6) Configure lsc

Create or update `~/.config/lsc/config.json` with at least these keys:

```json
{
  "modelsDir": "~/models",
  "llamaServerPath": "/absolute/path/to/llama.cpp/build/bin/llama-server"
}
```

On Windows, config path is:

```
C:\Users\<you>\.config\lsc\config.json
```

Notes:

- `modelsDir` can be any directory you store GGUF models in.
- `llamaServerPath` must be the absolute path to `llama-server`.

### 7) Run

```bash
lsc
```

If you want to start a server directly:

```bash
lsc start --model /absolute/path/to/model.gguf
```

### 8) Download models (optional)

You can download GGUF models with the TUI:

```bash
lsc
```

Then use the Download Manager inside the UI to fetch models into your `modelsDir`.

If you prefer manual downloads, place `.gguf` files into your `modelsDir` and verify:

```bash
lsc models
```

### 9) First-run checks

Confirm configuration:

```bash
lsc config list
```

If `llama-server` is not found, set it explicitly:

```bash
lsc config set llamaServerPath /absolute/path/to/llama-server
```
