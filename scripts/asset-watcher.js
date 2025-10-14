#!/usr/bin/env node
/**
 * Asset Request Watcher
 * 새 요청이 오면 stdout으로 알려줌
 */

const fs = require('fs');
const path = require('path');

const REQUESTS_FILE = path.join(__dirname, '../.claude-assets/requests.json');
const CHECK_INTERVAL = 2000; // 2초마다 확인

let lastProcessedIds = new Set();

// 초기화: 기존 요청들 ID 저장
function init() {
  try {
    if (fs.existsSync(REQUESTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf-8'));
      data.forEach(req => lastProcessedIds.add(req.id));
    }
  } catch (e) {
    // ignore
  }
  console.log('[Watcher] 에셋 요청 감시 시작...');
  console.log('[Watcher] 새 요청이 오면 자동으로 알려드립니다.\n');
}

function checkRequests() {
  try {
    if (!fs.existsSync(REQUESTS_FILE)) return;

    const data = JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf-8'));

    for (const req of data) {
      if (!lastProcessedIds.has(req.id) && !req.processed) {
        lastProcessedIds.add(req.id);
        console.log('\n========================================');
        console.log('[새 에셋 요청]');
        console.log(`ID: ${req.id}`);
        console.log(`내용: ${req.message}`);
        console.log(`시간: ${req.timestamp}`);
        console.log('========================================\n');
      }
    }
  } catch (e) {
    // ignore parse errors
  }
}

init();
setInterval(checkRequests, CHECK_INTERVAL);
