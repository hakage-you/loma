import { defineConfig, devices } from '@playwright/test';

// 性能の計測用。**合否は問わない。**
//
//   npm run perf            計測して表を出す
//   npm run perf -- -g 起動  一部だけ計測する
//
// 通常の e2e（playwright.config.ts / testDir ./e2e）とは別に持つ。
// 計測値はマシンの状態でぶれるので、CI の合否に混ぜると落ちるだけの検査になる。
// 使い方は「ブランチをマージする前に前後で回して数字を見る」「重いと感じたときに回す」。
//
// 結果は perf-results/latest.json にも残す（前後比較はこれを差分で見る）。
const PORT = 5198;

export default defineConfig({
  testDir: './perf',
  // 既定の testMatch は *.spec.ts / *.test.ts。計測は *.perf.ts で分ける
  testMatch: '**/*.perf.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 120_000,

  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1600, height: 1000 },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: `npm run dev:mock -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
