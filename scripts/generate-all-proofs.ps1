# 批量生成所有代币的 Merkle Proofs
# 使用方法: 
#   .\scripts\generate-all-proofs.ps1                    # 默认使用 arbitrum
#   .\scripts\generate-all-proofs.ps1 -Chain arbitrum
#   .\scripts\generate-all-proofs.ps1 -Chain opbnb
#   .\scripts\generate-all-proofs.ps1 -Chain gnosis

param(
    [string]$Chain = "arbitrum"
)

# 链配置映射（手动维护，与 chain-config.ts 保持一致）
$ChainConfigs = @{
    "arbitrum" = @{
        Symbols = @("ARB", "USDT", "WETH")
    }
    "opbnb" = @{
        Symbols = @("USDT", "WETH", "WBNB")
    }
    "gnosis" = @{
        Symbols = @("USDT", "WETH", "xDAI")
    }
}

# 验证链配置
if (-not $ChainConfigs.ContainsKey($Chain)) {
    Write-Host "错误: 不支持的链 '$Chain'" -ForegroundColor Red
    Write-Host "支持的链: $($ChainConfigs.Keys -join ', ')" -ForegroundColor Yellow
    exit 1
}

$Config = $ChainConfigs[$Chain]
$SYMBOLS = $Config.Symbols
$TIERS = @(1, 2, 3)

Write-Host "开始批量生成 Merkle Proofs (链: $Chain)..." -ForegroundColor Green
Write-Host ""

foreach ($symbol in $SYMBOLS) {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "处理代币: $symbol" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Cyan
    
    foreach ($tier in $TIERS) {
        Write-Host "  档位: $tier" -ForegroundColor Magenta
        
        $env:CSV_PATH = "./data/$Chain/$symbol/$tier.csv"
        
        # 检查文件是否存在
        if (Test-Path $env:CSV_PATH) {
            # 使用 --network 参数指定网络
            pnpm hardhat run scripts/generate-merkle-proofs.ts --network $Chain
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  $symbol 档位 $tier 完成" -ForegroundColor Green
            } else {
                Write-Host "  $symbol 档位 $tier 失败" -ForegroundColor Red
                exit 1
            }
        } else {
            Write-Host "  跳过 (文件不存在)" -ForegroundColor Gray
        }
        Write-Host ""
    }
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "所有 Merkle Proofs 生成完成!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "输出目录:" -ForegroundColor Yellow
Write-Host "  元数据: output/$Chain/metadata/{Symbol}/{Tier}.json"
Write-Host "  Proofs: output/$Chain/proof-map/{Symbol}/{Tier}.csv"
Write-Host ""
