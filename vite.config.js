import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 로컬 dev 프록시 target: 기본 로컬 mobis(8282), 원격 붙일 땐 API_TARGET=https://... npm run dev
const API_TARGET = process.env.API_TARGET || 'http://localhost:8282'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // 프로덕션 빌드는 dev API 서버의 public/flow-tester/ 에 얹혀 서빙됨 → 같은 도메인이라 CORS/프록시 불필요.
  // 로컬 dev 서버는 루트('/') 그대로 + 아래 프록시로 CORS 우회.
  base: command === 'build' ? '/flow-tester/' : '/',
  server: {
    port: 5180,        // 고정 포트 → 로컬 Base URL은 항상 http://localhost:5180
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
}))
