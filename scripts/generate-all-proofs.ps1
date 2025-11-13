# 批量生成所有代币的 Merkle Proofs
# 使用方法: .\scripts\generate-all-proofs.ps1

$CHAIN = "arbitrum"
$SYMBOLS = @("ARB", "WETH", "USDT")

Write-Host "开始批量生成 Merkle Proofs..." -ForegroundColor Green
Write-Host ""

foreach ($symbol in $SYMBOLS) {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "处理: $symbol" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Cyan
    
    $env:CSV_PATH = "./data/$CHAIN/$symbol.csv"
    pnpm hardhat run scripts/generate-merkle-proofs.ts
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "$symbol 处理完成" -ForegroundColor Green
        Write-Host ""
    } else {
        Write-Host ""
        Write-Host "$symbol 处理失败" -ForegroundColor Red
        exit 1
    }
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "所有代币的 Merkle Proofs 生成完成!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "输出目录:" -ForegroundColor Yellow
Write-Host "  元数据: output/$CHAIN/metadata/*.json"
Write-Host "  Proofs: output/$CHAIN/proof-map/*.csv"
Write-Host ""
