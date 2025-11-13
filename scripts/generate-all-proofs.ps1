# 批量生成所有代币的 Merkle Proofs
# 使用方法: .\scripts\generate-all-proofs.ps1

$CHAIN = "arbitrum"
$SYMBOLS = @("ARB", "WETH", "USDT")
$TIERS = @(1, 2, 3, 4, 5, 6, 7)

Write-Host "开始批量生成 Merkle Proofs..." -ForegroundColor Green
Write-Host ""

foreach ($symbol in $SYMBOLS) {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "处理代币: $symbol" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Cyan
    
    foreach ($tier in $TIERS) {
        Write-Host "  档位: $tier" -ForegroundColor Magenta
        
        $env:CSV_PATH = "./data/$CHAIN/$symbol/$tier.csv"
        
        # 检查文件是否存在
        if (Test-Path $env:CSV_PATH) {
            pnpm hardhat run scripts/generate-merkle-proofs.ts
            
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
Write-Host "  元数据: output/$CHAIN/metadata/{Symbol}/{Tier}.json"
Write-Host "  Proofs: output/$CHAIN/proof-map/{Symbol}/{Tier}.csv"
Write-Host ""
