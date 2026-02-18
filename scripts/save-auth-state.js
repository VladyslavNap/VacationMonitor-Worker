const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs').promises;

/**
 * Manual Login Script
 * Opens a browser where you can log in, then saves the session
 * Usage: node scripts/save-auth-state.js
 */

async function saveAuthState() {
  console.log('🚀 Starting manual login process...\n');
  
  const browser = await chromium.launch({ 
    headless: false,  // Browser window visible
    slowMo: 100
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1280, height: 720 }
  });
  
  const page = await context.newPage();
  
  console.log('📖 Opening Booking.com login page...');
  await page.goto('https://account.booking.com/sign-in', { 
    waitUntil: 'networkidle' 
  });
  
  console.log('\n✅ Browser window opened!');
  console.log('\n📝 Instructions:');
  console.log('   1. Log in to Booking.com in the browser window');
  console.log('   2. Complete any 2FA/verification if required');
  console.log('   3. Wait until you see your account name/profile');
  console.log('   4. Press ENTER in this terminal to save the session\n');
  
  // Wait for user to press Enter
  await waitForEnter();
  
  console.log('\n💾 Saving authentication state...');
  
  const dataDir = path.join(__dirname, '../data');
  await fs.mkdir(dataDir, { recursive: true }).catch(() => {});
  
  const authFile = path.join(dataDir, 'auth-state.json');
  await context.storageState({ path: authFile });
  
  console.log(`✅ Saved to: ${authFile}`);
  console.log('\n🎉 Success! Run "npm start" to use this session.\n');
  
  await browser.close();
}

function waitForEnter() {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question('Press ENTER when logged in... ', () => {
      rl.close();
      resolve();
    });
  });
}

saveAuthState().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});