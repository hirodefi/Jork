#!/bin/bash
set -e

echo ""
echo "Jork - Solana's Autonomous Build Engine"
echo "========================================"
echo ""

# check node
if ! command -v node &>/dev/null; then
    echo "Error: Node.js not found. Install Node 18+ first."
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt install -y nodejs"
    exit 1
fi

NODE_VER=$(node -e "console.log(parseInt(process.version.slice(1)))")
if [ "$NODE_VER" -lt 18 ]; then
    echo "Error: Node 18+ required. Found: $(node --version)"
    exit 1
fi

echo "Node $(node --version) found."

# install deps
echo "Installing dependencies..."
npm install

echo ""
echo "Done. Run 'npm run setup' to configure and start Jork."
