document.addEventListener('DOMContentLoaded', () => {

    // ── Elements ──
    const gameScreen   = document.getElementById('game-screen');
    const loadingOverlay = document.getElementById('loading-overlay');

    // ── Audio state ──
    let audioContext;
    let sfxAudioMap = {};
    let lastDoughHitTime = 0;
    let doughSequenceCounter = 0;

    // ── Game state ──
    let gamePattern = [];
    let currentGameIndex = 0;
    let gameFailed = false;
    let glowAnimationInterval = null;
    let missAnimationInterval = null;
    let nextRoundTimeoutId = null;
    let mashSuccessTimer = null;
    let firstPressTime = 0;
    let lastPressTime = 0;
    let lastScore = null; // { count, totalTimeMs, isNewBest }

    // ── Asset arrays ──
    const rabbitGlowFrames = Array.from({ length: 10 }, (_, i) =>
        `res/thanksgiving_rabbit_command_glow${String(i).padStart(2, '0')}.png`);
    const rabbitMissFrames = Array.from({ length: 16 }, (_, i) =>
        `res/thanksgiving_room_miss_rabbit${i}.png`);

    // ── Utilities ──
    const preloadImages = (urls) => Promise.all(urls.map(url => new Promise(resolve => {
        const img = new Image();
        img.src = url;
        img.onload = resolve;
        img.onerror = resolve;
    })));

    const showToast = (message) => {
        const existing = document.querySelector('.toast-message');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.className = 'toast-message';
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => { if (toast.parentElement) toast.remove(); }, 500);
        }, 2000);
    };

    // ── Audio ──
    const preloadSfx = async () => {
        if (!audioContext) return;
        try {
            const res = await fetch('sfx_config.json');
            if (!res.ok) throw new Error('sfx_config fetch failed');
            const sfxFiles = await res.json();
            await Promise.all(Object.keys(sfxFiles).map(async key => {
                const r = await fetch(sfxFiles[key]);
                sfxAudioMap[key] = await audioContext.decodeAudioData(await r.arrayBuffer());
            }));
        } catch (e) { console.error('SFX 로딩 실패:', e); }
    };

    const playSfx = (commandId) => {
        if (!audioContext) return;
        if (audioContext.state === 'suspended') audioContext.resume();
        let buf;
        if (commandId === 8) {
            const now = performance.now();
            doughSequenceCounter = (now - lastDoughHitTime < 50)
                ? (doughSequenceCounter + 1) % 4
                : 0;
            lastDoughHitTime = now;
            buf = sfxAudioMap[`8_${doughSequenceCounter}`];
        } else {
            buf = sfxAudioMap[commandId];
        }
        if (!buf) return;
        const src  = audioContext.createBufferSource();
        const gain = audioContext.createGain();
        src.buffer = buf;
        gain.gain.value = 0.15;
        src.connect(gain);
        gain.connect(audioContext.destination);
        src.start(0);
    };

    // ── Pattern generation ──
    const getEnabledCounts = () => {
        const checked = Array.from(document.querySelectorAll('.count-checkbox:checked'));
        return checked.length > 0 ? checked.map(cb => parseInt(cb.value, 10)) : [4];
    };

    const generatePattern = () => {
        const counts = getEnabledCounts();
        const count  = counts[Math.floor(Math.random() * counts.length)];
        return Array(count).fill(8);
    };

    const calcScore = (count, totalTimeMs) =>
        Math.round((count * 1000 / totalTimeMs) ** 2);

    // ── Score display ──
    const renderScoreDisplay = (el, score) => {
        if (!el) return;
        if (!score) { el.innerHTML = ''; return; }
        const { count, totalTimeMs, points } = score;
        el.className = '';
        el.innerHTML = `
            <div class="score-time">${points}점</div>
            <div class="score-count">${count}개 · ${Math.round(totalTimeMs)}ms</div>
            <div class="score-avg">평균 ${Math.round(totalTimeMs / count)}ms</div>`;
    };

    // ── Miss animation ──
    const showMissAnimation = () => {
        if (missAnimationInterval) clearInterval(missAnimationInterval);
        const overlays = document.querySelectorAll('.miss-overlay');
        let frame = 0;
        for (let i = currentGameIndex; i < gamePattern.length; i++) {
            if (overlays[i]) overlays[i].classList.remove('hidden');
        }
        missAnimationInterval = setInterval(() => {
            for (let i = currentGameIndex; i < gamePattern.length; i++) {
                if (overlays[i]) overlays[i].src = rabbitMissFrames[frame];
            }
            frame++;
            if (frame >= rabbitMissFrames.length) frame = 7;
        }, 60);
    };

    // ── Glow indicator ──
    const updateGlowIndicator = () => {
        if (glowAnimationInterval) clearInterval(glowAnimationInterval);
        const glowEl = gameScreen.querySelector('.glow-indicator');
        if (!glowEl) return;

        if (currentGameIndex >= gamePattern.length) {
            glowEl.classList.add('hidden');
            return;
        }

        const wrappers = document.querySelectorAll('.command-icon-wrapper');
        const target   = wrappers[currentGameIndex];
        if (!target) { glowEl.classList.add('hidden'); return; }

        const areaRect = gameScreen.querySelector('.game-area').getBoundingClientRect();
        const rect     = target.getBoundingClientRect();
        glowEl.style.top  = `${rect.top  - areaRect.top  + rect.height / 2}px`;
        glowEl.style.left = `${rect.left - areaRect.left + rect.width  / 2}px`;
        glowEl.src = rabbitGlowFrames[0];
        glowEl.classList.remove('hidden');

        let frame = 1;
        glowAnimationInterval = setInterval(() => {
            glowEl.src = rabbitGlowFrames[frame];
            frame = (frame + 1) % rabbitGlowFrames.length;
        }, 80);
    };

    const positionGlowReliably = () => {
        const wrappers = document.querySelectorAll('.command-icon-wrapper');
        if (!wrappers.length) { requestAnimationFrame(positionGlowReliably); return; }
        const rect = wrappers[0].getBoundingClientRect();
        if (!rect.width || !rect.height) { requestAnimationFrame(positionGlowReliably); return; }
        updateGlowIndicator();
    };

    // ── Scroll animation ──
    const animateScroll = (targetY) => {
        const scrollContent = gameScreen.querySelector('.scroll-content');
        if (!scrollContent) return;
        scrollContent.style.transition = 'none';
        const startY   = parseFloat(scrollContent.style.transform.replace('translateY(', '')) || 0;
        const duration = 300;
        let startTime  = null;
        const ease = t => t < 0.5 ? 4*t*t*t : (t-1)*(2*t-2)*(2*t-2)+1;

        function step(ts) {
            if (!startTime) startTime = ts;
            const elapsed = ts - startTime;
            const pct = Math.min(elapsed / duration, 1);
            scrollContent.style.transform = `translateY(${startY + (targetY - startY) * ease(pct)}px)`;
            updateGlowIndicator();
            if (elapsed < duration) requestAnimationFrame(step);
            else scrollContent.style.transition = '';
        }
        requestAnimationFrame(step);
    };

    // ── Floor rendering ──
    const renderFloorButtons = () => {
        const floorContainer = gameScreen.querySelector('.floor-container');
        if (!floorContainer) return;

        floorContainer.innerHTML = `
            <img src="res/thanksgiving_room_container_top.png" class="floor-top">
            <div class="button-layout-container">
                <div class="button-cluster">
                    <div class="button-wrapper rabbit-cmd8">
                        <img src="res/thanksgiving_room_command8_unpressed.png"
                             class="floor-button game-command"
                             data-command="command8">
                    </div>
                </div>
            </div>`;

        floorContainer.querySelectorAll('.game-command').forEach(setupButtonListeners);
    };

    // ── Game logic ──
    const handleCorrectInput = () => {
        playSfx(8);

        const icon = document.querySelectorAll('.command-icon')[currentGameIndex];
        if (icon) {
            icon.src = icon.src.replace('.png', '_off.png');
            icon.classList.add('popping');
            icon.addEventListener('animationend', () => icon.classList.remove('popping'), { once: true });
        }

        currentGameIndex++;

        if (currentGameIndex === gamePattern.length) {
            lastPressTime = performance.now();
        }

        if (currentGameIndex % 6 === 0 && currentGameIndex < gamePattern.length) {
            const box       = document.querySelector('.command-box');
            const rowHeight = box ? box.offsetHeight : 65;
            animateScroll(-((currentGameIndex / 6) * rowHeight));
        }
    };

    const processNextCommand = () => {
        if (gameFailed) return;

        if (currentGameIndex >= gamePattern.length) {
            // 모두 눌렀음 — 1초 안에 추가 입력 없으면 성공
            mashSuccessTimer = setTimeout(() => onRoundEnd(true), 1000);
            return;
        }

        updateGlowIndicator();
    };

    const handlePlayerInput = (commandId) => {
        if (gameFailed) return;
        if (commandId !== 8) return;

        // 패턴을 초과해서 누르면 실패
        if (currentGameIndex >= gamePattern.length) {
            if (mashSuccessTimer) { clearTimeout(mashSuccessTimer); mashSuccessTimer = null; }
            onRoundEnd(false);
            return;
        }

        // 첫 번째 입력: 시작 시간 기록
        if (currentGameIndex === 0) {
            firstPressTime = performance.now();
        }

        handleCorrectInput();
        processNextCommand();
    };

    const onRoundEnd = (isSuccess) => {
        gameFailed = true;

        if (isSuccess) {
            if (glowAnimationInterval) clearInterval(glowAnimationInterval);
            const glowEl = gameScreen.querySelector('.glow-indicator');
            if (glowEl) glowEl.classList.add('hidden');

            const scrollContent = gameScreen.querySelector('.scroll-content');
            if (scrollContent) scrollContent.style.display = 'none';

            const totalTimeMs = lastPressTime - firstPressTime;
            const count       = gamePattern.length;
            const points      = calcScore(count, totalTimeMs);

            lastScore = { count, totalTimeMs, points };
            renderScoreDisplay(gameScreen.querySelector('#round-display'), lastScore);

            playSfx('success');
        } else {
            showMissAnimation();
            playSfx('fail');
            showToast('실패');
        }

        nextRoundTimeoutId = setTimeout(startNewRound, 1000);
    };

    const startNewRound = () => showGameScreen();

    // ── Show game screen ──
    const showGameScreen = async () => {
        // 진행 중인 타이머 모두 취소
        if (nextRoundTimeoutId)   { clearTimeout(nextRoundTimeoutId);  nextRoundTimeoutId  = null; }
        if (mashSuccessTimer)     { clearTimeout(mashSuccessTimer);     mashSuccessTimer    = null; }
        if (glowAnimationInterval){ clearInterval(glowAnimationInterval); glowAnimationInterval = null; }
        if (missAnimationInterval){ clearInterval(missAnimationInterval); missAnimationInterval = null; }

        if (audioContext && audioContext.state === 'suspended') audioContext.resume();

        gamePattern      = generatePattern();
        currentGameIndex = 0;
        gameFailed       = false;
        firstPressTime   = 0;
        lastPressTime    = 0;

        gameScreen.classList.remove('hidden');

        // 패턴 행 생성 (6개씩 묶음)
        const rows = [];
        for (let i = 0; i < gamePattern.length; i += 6) {
            const row = gamePattern.slice(i, i + 6);
            rows.push(`
                <div class="command-box">
                    ${row.map(() => `
                        <div class="command-icon-wrapper">
                            <img src="res/thanksgiving_room_command8.png" class="command-icon">
                            <img class="miss-overlay hidden">
                        </div>`).join('')}
                </div>`);
        }

        const savedFloor = gameScreen.querySelector('.floor-container');
        if (savedFloor) savedFloor.remove();

        gameScreen.innerHTML = `
            <div class="ceiling">
                <div id="round-display"></div>
            </div>
            <div class="game-area">
                <img class="glow-indicator hidden">
                <div class="scroll-viewport">
                    <div class="scroll-content">${rows.join('')}</div>
                </div>
            </div>
            <div class="floor-container"></div>`;

        // 이전 점수 복원
        renderScoreDisplay(gameScreen.querySelector('#round-display'), lastScore);

        await Promise.all(
            Array.from(gameScreen.querySelectorAll('.command-icon'))
                .map(img => img.decode().catch(() => {}))
        );

        if (savedFloor) {
            gameScreen.querySelector('.floor-container').replaceWith(savedFloor);
        } else {
            renderFloorButtons();
        }

        positionGlowReliably();
    };

    // ── Button event wiring ──
    function handlePress(event) {
        const t = event.currentTarget;
        t.classList.add('pressed');
        if (t.classList.contains('floor-button') && t.src && t.src.includes('_unpressed.png'))
            t.src = t.src.replace('_unpressed.png', '_pressed.png');
    }

    function handleRelease(event) {
        const t = event.currentTarget;
        t.classList.remove('pressed');
        if (t.classList.contains('floor-button') && t.src && t.src.includes('_pressed.png'))
            t.src = t.src.replace('_pressed.png', '_unpressed.png');
    }

    function handleActivation(event) {
        const t = event.currentTarget;
        if (t.classList.contains('exit-button')) {
            showGameScreen();
        } else if (t.hasAttribute('data-command')) {
            handlePlayerInput(parseInt(t.dataset.command.replace('command', ''), 10));
        }
    }

    function setupButtonListeners(btn) {
        if (!btn) return;
        btn.addEventListener('mousedown', handlePress);
        btn.addEventListener('mouseup',   e => { handleRelease(e); handleActivation(e); });
        btn.addEventListener('mouseleave', handleRelease);
        btn.addEventListener('touchstart', e => { e.preventDefault(); handlePress(e); },   { passive: false });
        btn.addEventListener('touchend',   e => { e.preventDefault(); handleRelease(e); handleActivation(e); }, { passive: false });
        btn.addEventListener('touchcancel', handleRelease);
    }

    // ── Init ──
    const initializeApp = async () => {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) { console.error('Web Audio API 미지원:', e); }

        await preloadSfx();

        await preloadImages([
            'res/thanksgiving_room_command8.png',
            'res/thanksgiving_room_command8_off.png',
            'res/thanksgiving_room_command8_pressed.png',
            'res/thanksgiving_room_command8_unpressed.png',
            'res/thanksgiving_room_container_top.png',
            'res/thanksgiving_room_exit_unpressed.png',
            ...rabbitGlowFrames,
            ...rabbitMissFrames,
        ]);

        loadingOverlay.classList.add('hidden');

        // 로딩 완료 즉시 게임 시작
        showGameScreen();
    };

    initializeApp();
});
