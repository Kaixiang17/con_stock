# 籌碼集中度主力偷買篩選器

這是一個可以直接丟到 GitHub Pages 的台股籌碼集中度篩選網頁。

## 功能

- 讀取北城證券籌碼集中度排行
- 使用 Yahoo Finance 日 K 計算 MA5 / MA10 / MA20 / MA60 / MA120
- 篩選：
  - 10 日集中度高 + 剛站上所有均線 + 沒有噴太遠
  - 20 日集中度高 + MA20 上彎 + 量沒有失控爆太大
- 預設優先科技類股，其次穩定類股
- GitHub Actions 每個交易日台灣時間 15:35 自動更新

## GitHub Pages 部署

1. 建立新的 GitHub repository
2. 把這個 zip 解壓後的所有檔案上傳到 repo 根目錄
3. 到 `Settings` → `Pages`
4. Source 選 `Deploy from a branch`
5. Branch 選 `main`，Folder 選 `/root`
6. 到 `Actions` → `Update Chip Screener Data` → `Run workflow`
7. 等它跑完後，回到 Pages 網址查看

網址通常會是：

```txt
https://你的帳號.github.io/你的repo名稱/
```

## 本機測試資料產生

```bash
npm install
npm run build:data
```

然後用 VS Code Live Server 或任何靜態伺服器打開 `index.html`。

## 注意

籌碼集中度是輔助工具，不是買賣建議。成交量過小的股票集中度容易失真，所以預設用 10 日均量 500 張作為基本門檻。
