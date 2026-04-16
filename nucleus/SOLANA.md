# Solana Builder Knowledge

Dense reference. Every word carries weight. Read this on boot, search it when building.

## Account Model

Everything is an account: 5 fields (lamports, data, owner, executable, rent_epoch). Max data: 10 MiB. Address: 32-byte Ed25519 pubkey or PDA. Only the owner program can modify data or debit lamports. Any program can credit lamports. Rent-exempt formula: `(size + 128) * 3480 * 2` lamports.

## Programs

Accounts with `executable: true` containing sBPF bytecode. Stateless. All mutable state in separate data accounts. Default heap 32 KiB, max 256 KiB. Stack frame 4096 bytes. Max CPI depth 5. Deploy via Loader-v3 (BPF Loader Upgradeable). Upgrade authority can be revoked for immutability.

## PDAs

Deterministic off-curve addresses. `findProgramAddress(seeds, programId)` tries bumps 255 to 0. Max 16 seeds, 32 bytes each. No private key exists. Only owning program can sign via `invoke_signed`. Common patterns: `["user", user_pubkey]`, `["vault", pool_pubkey]`, `["metadata", mint_pubkey]`.

## CPIs

`invoke` when all signers already signed. `invoke_signed` when program signs for PDA. Max depth 5. Cost 1000 CU per call. Max 16 PDA signers. Max return data 1024 bytes. Privileges extend from caller to callee, cannot escalate. Direct self-recursion allowed, indirect reentrancy blocked.

## Transactions

Max size 1232 bytes. Max 64 accounts. Max 64 instructions (incl CPIs). Max compute 1,400,000 CU per tx. Default 200,000 CU per instruction. Base fee: 5000 lamports/signature (50% burned). Priority fee: `ceil(price * limit / 1,000,000)` lamports. Blockhash valid ~60-90 seconds. V0 transactions support Address Lookup Tables.

## Clusters

| Cluster | URL |
|---------|-----|
| Devnet | `https://api.devnet.solana.com` |
| Testnet | `https://api.testnet.solana.com` |
| Mainnet | `https://api.mainnet-beta.solana.com` |
| Local | `http://127.0.0.1:8899` |

Public endpoints are rate-limited, not for production. Use Helius free tier (1M credits/mo, 10 RPS) or QuickNode free (10M credits/mo, 15 RPS) for real work.

## CLI Setup

```bash
# Install everything
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash

# Verify
rustc --version && solana --version && anchor --version

# Configure
solana config set --url devnet
solana-keygen new --outfile ~/.config/solana/devnet.json
solana config set --keypair ~/.config/solana/devnet.json
solana airdrop 2  # devnet only, may rate-limit
```

## Version Compatibility

Use tested combinations. Wrong versions = hours of debugging.

| Setup | Anchor | Solana CLI | Rust | Platform Tools |
|-------|--------|-----------|------|---------------|
| Recommended | 0.32.1 | 3.x (Agave) | 1.89+ | v1.44+ |
| Stable | 0.30.1 | 1.18.x | 1.79 | v1.41 |

If edition2024 errors: pin the crate in `[patch.crates-io]`. Common: blake3, constant_time_eq, base64ct.

## Anchor Framework

The standard for Solana program development. Current: 0.32.1. Requires Solana 2.3.0+, Rust 1.89.0+.

```bash
# Install
avm install 0.32.1 && avm use 0.32.1

# Project lifecycle
anchor init my-project
anchor build
anchor test
anchor deploy
anchor keys list
anchor keys sync  # sync declare_id with keypair
anchor verify <program-id>  # verifiable build check
```

### Program Structure

```rust
use anchor_lang::prelude::*;

declare_id!("YourProgramId");

#[program]
mod my_program {
    use super::*;
    pub fn initialize(ctx: Context<Initialize>, data: u64) -> Result<()> {
        ctx.accounts.my_account.data = data;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = signer, space = 8 + 8)]
    pub my_account: Account<'info, MyAccount>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct MyAccount {
    pub data: u64,  // 8 bytes + 8 discriminator = space 16
}
```

### Key Constraints

`init, payer = x, space = N` create account. `mut` mutable. `seeds = [...], bump` PDA validation. `has_one = field` field match. `close = target` close and reclaim rent. `token::mint = m, token::authority = a` SPL token checks. `constraint = expr` arbitrary check. `realloc = SIZE, realloc::payer = p` resize.

### Space Calculation

8-byte discriminator + fields. bool=1, u8=1, u16=2, u32=4, u64=8, u128=16, Pubkey=32, Vec=4+len*size, String=4+bytes, Option=1+size. Use `#[derive(InitSpace)]` with `#[max_len(N)]`.

### Account Types

`Account<T>` typed+checked. `Signer` must sign. `SystemAccount` system-owned. `Program<T>` program check. `UncheckedAccount` no checks (document why). `AccountLoader<T>` zero-copy for large accounts. `InterfaceAccount<T>` Token/Token-2022 compatible.

## SPL Tokens

Two programs: Token (original, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) and Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).

Mint account: supply, decimals, authorities. Token account: mint, owner, amount, delegate. ATA: deterministic PDA from `[owner, token_program, mint]`.

```bash
spl-token create-token                           # create mint
spl-token create-account <MINT>                  # create token account
spl-token mint <MINT> <AMOUNT>                   # mint tokens
spl-token transfer <MINT> <AMOUNT> <RECIPIENT>   # transfer
```

### Token-2022 Extensions

Enabled at mint creation, most cannot be added after. Key extensions: TransferFee, TransferHook, MetadataPointer+TokenMetadata (on-chain metadata without Metaplex), PermanentDelegate, NonTransferable (soulbound), DefaultAccountState, InterestBearing, CpiGuard, Pausable.

```bash
# Token with on-chain metadata
spl-token create-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --enable-metadata
spl-token initialize-metadata <MINT> <NAME> <SYMBOL> <URI>

# Token with transfer fees (0.5%)
spl-token create-token --transfer-fee-basis-points 50 --transfer-fee-maximum-fee 5000

# Soulbound token
spl-token create-token --enable-non-transferable
```

## NFTs (Metaplex)

Two standards: Core (new, simpler, cheaper) and Token Metadata (legacy).

### Metaplex Core

~0.003 SOL per asset. Uses Umi framework.

```bash
npm install @metaplex-foundation/mpl-core @metaplex-foundation/umi-bundle-defaults
```

```typescript
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { create, mplCore } from '@metaplex-foundation/mpl-core'

const umi = createUmi('https://api.devnet.solana.com').use(mplCore())
await create(umi, { name: 'My NFT', uri: 'https://example.com/metadata.json' }).sendAndConfirm(umi)
```

Plugins: Royalties (basis points + creators), Freeze, Burn, Transfer, Update delegates. Collections supported natively.

### Compressed NFTs (Bubblegum v2)

~0.00001 SOL per cNFT. Merkle tree, ~1M cNFTs for ~8.5 SOL rent. Requires DAS API-compatible RPC (Helius has this). V2 adds freeze/thaw, soulbound, Core collection integration.

## Client SDKs

### @solana/kit (new, recommended)

Replaces @solana/web3.js. Functional, tree-shakable, zero deps. 80% smaller bundle, 10x faster crypto.

```bash
npm install @solana/kit
```

```typescript
import { createSolanaRpc } from '@solana/kit';
const rpc = createSolanaRpc('https://api.devnet.solana.com');
```

Companion packages: `@solana-program/system`, `@solana-program/token`, `@solana-program/compute-budget`.

### @solana/web3.js (legacy, still widely used)

```bash
npm install @solana/web3.js
```

```typescript
import { Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
```

### Anchor Client

```typescript
import * as anchor from '@coral-xyz/anchor';
const provider = anchor.AnchorProvider.env();
const program = new anchor.Program(idl, provider);
await program.methods.initialize(new anchor.BN(42)).accounts({ myAccount, signer }).rpc();
```

## Wallet Adapter (Frontend)

### Modern (@solana/react-hooks)

```bash
npm install @solana/client @solana/react-hooks @solana/kit
```

```tsx
import { SolanaProvider } from '@solana/react-hooks';
// Wrap app in SolanaProvider with cluster config
```

### Legacy (@solana/wallet-adapter)

```bash
npm install @solana/wallet-adapter-base @solana/wallet-adapter-react @solana/wallet-adapter-react-ui
```

Three providers: ConnectionProvider, WalletProvider, WalletModalProvider. Use `WalletMultiButton` for UI. Supports Phantom, Solflare, Backpack.

## Frontend (Solana)

Use whatever the user asks for. If they say React, use React (Vite). If they say Next.js, use Next.js. If they don't specify, pick what fits best.

**React (Vite):**
```bash
npm create vite@latest my-dapp -- --template react
cd my-dapp && npm install @solana/web3.js @solana/wallet-adapter-react @solana/wallet-adapter-react-ui @solana/wallet-adapter-wallets
```

**Next.js:**
```bash
npx create-next-app@latest my-dapp
cd my-dapp && npm install @solana/kit @solana/react-hooks
```

Both use wallet-adapter for connection. Wrap app in ConnectionProvider + WalletProvider + WalletModalProvider.

## Deployment Flow

### Local Development
```bash
anchor init my-project && cd my-project
anchor build
anchor test  # starts local validator, runs tests, stops
```

### Devnet
```bash
solana config set --url devnet
solana airdrop 5
anchor build
anchor deploy  # auto-uploads IDL
anchor test --skip-local-validator  # test against devnet
```

### Mainnet
```bash
solana config set --url mainnet-beta
# Use a funded keypair
anchor build --verifiable  # deterministic build
anchor deploy
anchor verify <program-id>  # verify on-chain matches
```

### Program Upgrades
```bash
anchor build
anchor upgrade target/deploy/my_program.so --program-id <PROGRAM_ID>
anchor idl upgrade --filepath target/idl/my_program.json <PROGRAM_ID>
```

### Make Immutable
```bash
solana program set-upgrade-authority <PROGRAM_ID> --final
```

## Server Setup

### Nginx Config (frontend + API)
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;  # Next.js
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }

    location /api/rpc {
        proxy_pass https://mainnet.helius-rpc.com/?api-key=YOUR_KEY;
        proxy_set_header Host mainnet.helius-rpc.com;
    }
}
```

### SSL
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

### PM2
```bash
pm2 start npm --name my-dapp -- start
pm2 save && pm2 startup
```

### Firewall
```bash
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

## Priority Fees

```typescript
// Legacy
import { ComputeBudgetProgram } from '@solana/web3.js';
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }));

// Modern
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
```

Workflow: build tx with 400K CU placeholder, simulate to get actual, multiply by 1.1, rebuild with tight limit. Compute budget instructions must be first.

## Common Architectures

**Token Launch:** Create mint (Token-2022 with metadata), set supply, create ATA for distribution, optional transfer fees, frontend with wallet adapter for claiming.

**NFT Collection:** Metaplex Core for individual assets or Bubblegum for compressed. Upload metadata to Arweave/IPFS. Candy Machine for managed minting with guards (payment, allowlist, dates).

**AMM/DEX:** Two token vaults (PDAs), LP mint, constant product formula (x*y=k). CPIs to Token Program for swaps. Oracle (Pyth) for price feeds. Priority fees critical during congestion.

**Lending:** Collateral vaults, loan accounts tracking borrowed amount + interest. Oracle for collateral pricing. Liquidation logic when LTV exceeds threshold.

**Staking:** Stake pool account, user stake accounts (PDAs), reward calculation per epoch or block. CPI to Token Program for reward distribution.

**DAO/Governance:** Proposal accounts, vote accounts (PDA per voter per proposal), execution threshold, timelock. SPL Governance program or custom.

**Solana Actions/Blinks:** REST API returning transaction for wallet to sign. `GET` returns metadata, `POST` returns serialized transaction. Lightweight integration point for any web service.

## Security Checklist

1. Validate all account owners (Anchor does this automatically with typed accounts)
2. Check signer status on authority operations
3. Use `has_one` or explicit checks for account relationships
4. Close accounts properly (zero data before closing to prevent revival attacks)
5. Check for integer overflow/underflow (use checked_math or saturating ops)
6. Validate PDA bumps (store canonical bump, don't re-derive)
7. Never trust client-provided account data without on-chain validation
8. Use `constraint` for business logic validation
9. Test with malicious inputs (wrong accounts, wrong signers, overflow values)
10. Audit before mainnet. At minimum: Sec3, OtterSec, Neodyme.

## Ecosystem Map

### RPC and Infrastructure
- **Helius** (helius.dev) - Best free tier (1M credits/mo). DAS API for NFTs. Webhooks, enhanced transactions API. Devnet+mainnet.
- **QuickNode** (quicknode.com) - 10M credits/mo free. Solana-specific add-ons.
- **Triton** (triton.one) - Enterprise. No free tier.
- Public endpoints for dev only. Rate-limited, will 429 in production.

### DEX and Trading
- **Jupiter** (jup.ag) - The aggregator. Routes through all DEXs for best price. V6 API for swaps. Limit orders, DCA, perps. Jupiter Terminal for embeddable swap UI. `https://quote-api.jup.ag/v6/quote` and `/swap` endpoints.
- **Raydium** (raydium.io) - AMM + CLMM (concentrated liquidity). Largest TVL. AcceleRaytor for launches.
- **Meteora** (meteora.ag) - DLMM (Dynamic Liquidity Market Maker). Innovative bin-based liquidity. Good for new token launches.
- **Orca** (orca.so) - Whirlpools (concentrated liquidity). Clean SDK.
- **OKX DEX** (okx.com/web3/dex) - Cross-chain aggregator with Solana support. API available.

### Token Launch Platforms
- **Pump.fun** (pump.fun) - One-click token launch. Bonding curve, auto-LP on Raydium at graduation. The standard for memecoin launches. API exists for programmatic interaction.
- **Bonk.fun** (bonk.fun) - Similar launch platform, Bonk ecosystem.
- **bags.fm** (bags.fm) - Social token platform. Agent-friendly. Hackathon-style launches.

### NFT and Digital Assets
- **Metaplex** (metaplex.com) - The standard. Core (new), Token Metadata (legacy), Bubblegum (compressed). Umi SDK.
- **Tensor** (tensor.trade) - NFT marketplace. cNFT support. API for trading.
- **Magic Eden** (magiceden.io) - Largest marketplace. Multi-chain now but Solana-native.

### Oracles
- **Pyth** (pyth.network) - Real-time price feeds. 400+ feeds. Pull-based oracle. `@pythnetwork/pyth-solana-receiver`
- **Switchboard** (switchboard.xyz) - Custom data feeds. Oracle queues.

### Storage
- **Arweave** - Permanent storage. Pay once. Standard for NFT metadata.
- **IPFS/Pinata** - Pinned content. Needs ongoing pinning.
- **Shadow Drive** - Solana-native storage. SHDW token.
- **Irys** (irys.xyz) - Arweave upload layer. Metaplex default uploader.

### Wallets
- **Phantom** - Most popular. Browser + mobile. Deep Solana integration.
- **Solflare** - Solana-only. Good staking UX.
- **Backpack** - xNFT platform. Developer-friendly.

### Developer Tools
- **Anchor** - Program framework (covered above)
- **Solana Playground** (beta.solpg.io) - Browser IDE for Solana programs
- **Solana Explorer** (explorer.solana.com) - Transaction/account viewer
- **Solscan** (solscan.io) - Alternative explorer with better token views
- **Amman** - Local validator toolkit for testing
- **LiteSVM** - Fast in-process VM for tests (Rust, TS, Python)

### Key APIs for Building
```
Jupiter Swap:     https://quote-api.jup.ag/v6/quote?inputMint=So11...&outputMint=EPjF...&amount=100000000
Jupiter Price:    https://price.jup.ag/v6/price?ids=SOL
Helius RPC:       https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
Helius DAS:       POST to RPC with method "getAssetsByOwner"
Pyth Price Feed:  On-chain account reads via @pythnetwork/pyth-solana-receiver
Metaplex Umi:     @metaplex-foundation/umi-bundle-defaults
```

## Self-Updating Knowledge

When I encounter something new (new protocol, updated API, new pattern), I append it to this file or create a note in my memory. My knowledge grows with every project I build. If a user mentions a protocol I do not know, I research it immediately and add what I learn.
