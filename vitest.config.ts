import { defineConfig } from 'vitest/config';

// Integration tests run against the Docker test database only (docker/booking/docker-compose.yml).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://cgtest:cgtest@localhost:55432/cgtest',
      MAIL_TRANSPORT: 'log',
      API_SECRET: 'test-secret-test-secret-test-secret',
      DASHBOARD_URL: 'https://dashboard.test',
      BOOKING_PAGE_URL: 'https://book.test',
    },
  },
});
