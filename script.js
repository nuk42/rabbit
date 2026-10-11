document.addEventListener('DOMContentLoaded', () => {

    const gameScreen     = document.getElementById('game-screen');
    const loadingOverlay = document.getElementById('loading-overlay');

    let audioContext;
    let sfxAudioMap = {};
    let lastDoughHitTime = 0;
    let doughSequenceCounter = 0;

    let gamePattern = [];
    let currentGameIndex = 0;
    let gameFailed = false;
    let glowAnimationInterval = null;
    let missAnimationInterval = null;
    let nextRoundTimeoutId = null;
    let mashSuccessTimer = null;
    let roundTimer = null;
    let firstPressTime = 0;
    let lastPressTime = 0;
    let lastScore = null;

    // --- Okma mode state ---
    let okmaBotActionTimeout = null;
    let okmaRabbitPressCount = 0;

    // --- Tab / difficulty ---
    let activeTab = 'mash'; // 'mash' | 'okma'
    let okmaDifficulty = 4;
    let okmaSidan = false;

    // --- Okma constants (bot config from songpyeon/bot_config.json) ---
    const OKMA_BASE_PATTERN = 'RpttttttttttttRptttttttttttttt';
    const OKMA_BOT_DELAYS = {
        initial_reaction_delay_ms: 100,
        press_delays_ms: { 1: 50, 2: 50, 3: 50, 6: 50 }
    };

    // --- Image frame arrays ---
    const pigGlowFrames = Array.from({ length: 10 }, (_, i) =>
        `res/thanksgiving_pig_command_glow${String(i).padStart(2, '0')}.png`);
    const rabbitGlowFrames = Array.from({ length: 10 }, (_, i) =>
        `res/thanksgiving_rabbit_command_glow${String(i).padStart(2, '0')}.png`);
    const rabbitMissFrames = Array.from({ length: 16 }, (_, i) =>
        `res/thanksgiving_room_miss_rabbit${i}.png`);

    // --- Utilities ---
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

    // --- Audio ---
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

    // --- Controls ---
    const getEnabledCounts = () => {
        const checked = Array.from(document.querySelectorAll('.count-checkbox:checked'));
        return checked.length > 0 ? checked.map(cb => parseInt(cb.value, 10)) : [4];
    };

    // --- Okma pattern helpers ---
    const transformRabbitPatterns = (patternString, factor) => {
        let result = '';
        let i = 0;
        while (i < patternString.length) {
            let processed = false;
            if (patternString.substring(i, i + 4) === 'tttt') {
                result += Math.random() < factor ? 'rr' : 'tttt';
                i += 4;
                processed = true;
            }
            if (!processed && patternString.substring(i, i + 6) === 'tttttt') {
                result += Math.random() < factor ? 'rttr' : 'tttttt';
                i += 6;
                processed = true;
            }
            if (!processed) {
                if (patternString[i] === 't' && patternString[i + 1] === 't') {
                    result += 'tt';
                    i += 2;
                } else {
                    result += patternString[i];
                    i++;
                }
            }
        }
        return result;
    };

    const adjustPatternDifficulty = (patternString, level) => {
        if (level <= 0) return patternString;
        const regex = /(Rp|tt)/g;
        const segments = [];
        let match;
        while ((match = regex.exec(patternString)) !== null) {
            segments.push({ type: match[0], index: match.index });
        }
        if (!segments.length) return patternString;

        const budget = Math.floor(Math.random() * (level + 1));
        const counts = new Array(segments.length).fill(0);
        let remaining = budget;
        const maxPer = budget >= 4 ? Math.floor(budget / 4) : budget;

        while (remaining > 0) {
            const candidates = segments.map((_, i) => i).filter(i => counts[i] < maxPer);
            const pool = candidates.length ? candidates : segments.map((_, i) => i);
            counts[pool[Math.floor(Math.random() * pool.length)]]++;
            remaining--;
        }

        let result = '', lastIdx = 0;
        segments.forEach((seg, si) => {
            result += patternString.substring(lastIdx, seg.index);
            result += seg.type.repeat(1 + counts[si]);
            lastIdx = seg.index + seg.type.length;
        });
        result += patternString.substring(lastIdx);
        return result;
    };

    const parseOkmaPattern = (str) => {
        const pigNormal    = [1, 2, 3];
        const rabbitNormal = [4, 5, 7];
        return [...str].flatMap(c => {
            if (c === 'R') return [pigNormal[Math.floor(Math.random() * 3)]];
            if (c === 'p') return [6];
            if (c === 't') return [8];
            if (c === 'r') return [rabbitNormal[Math.floor(Math.random() * 3)]];
            return [];
        });
    };

    // --- Pattern generation ---
    const generatePattern = () => {
        if (activeTab === 'okma') {
            const adjusted    = adjustPatternDifficulty(OKMA_BASE_PATTERN, okmaDifficulty);
            const rabbitFactor = 0.7;
            const transformed = transformRabbitPatterns(adjusted, rabbitFactor);
            return parseOkmaPattern(transformed);
        }
        const counts = getEnabledCounts();
        const count  = counts[Math.floor(Math.random() * counts.length)];
        return Array(count).fill(8);
    };

    // --- Score ---
    const calcScore = (count, totalTimeMs) =>
        Math.round((count * 1000 / totalTimeMs) ** 2);

    const renderScoreDisplay = (el, score) => {
        if (!el) return;
        if (!score) { el.innerHTML = ''; return; }
        const { count, totalTimeMs, points } = score;
        el.innerHTML = `
            <div class="score-time">${points}점</div>
            <div class="score-count">${count}개 · ${Math.round(totalTimeMs)}ms</div>
            <div class="score-avg">평균 ${Math.round(totalTimeMs / count)}ms</div>`;
    };

    // --- Miss animation ---
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

    // --- Glow indicator ---
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

        const commandId = gamePattern[currentGameIndex];
        const isPig = [1, 2, 3, 6].includes(commandId);
        const frames = isPig ? pigGlowFrames : rabbitGlowFrames;
        glowEl.src = frames[0];
        glowEl.classList.remove('hidden');

        let frame = 1;
        glowAnimationInterval = setInterval(() => {
            glowEl.src = frames[frame];
            frame = (frame + 1) % frames.length;
        }, 80);
    };

    const positionGlowReliably = () => {
        const wrappers = document.querySelectorAll('.command-icon-wrapper');
        if (!wrappers.length) { requestAnimationFrame(positionGlowReliably); return; }
        const rect = wrappers[0].getBoundingClientRect();
        if (!rect.width || !rect.height) { requestAnimationFrame(positionGlowReliably); return; }
        updateGlowIndicator();
    };

    // --- Scroll ---
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

    // --- Floor buttons ---
    const renderFloorButtons = () => {
        const floorContainer = gameScreen.querySelector('.floor-container');
        if (!floorContainer) return;
        floorContainer.dataset.mode = 'mash';

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

    const renderOkmaFloorButtons = () => {
        const floorContainer = gameScreen.querySelector('.floor-container');
        if (!floorContainer) return;
        floorContainer.dataset.mode = 'okma';

        floorContainer.innerHTML = `
            <img src="res/thanksgiving_room_container_top.png" class="floor-top">
            <div class="button-layout-container">
                <div class="button-cluster">
                    <div class="button-wrapper rabbit-cmd8">
                        <img src="res/thanksgiving_room_command8_unpressed.png"
                             class="floor-button game-command" data-command="command8">
                    </div>
                    <div class="button-wrapper rabbit-cmd4">
                        <img src="res/thanksgiving_room_command4_unpressed.png"
                             class="floor-button game-command" data-command="command4">
                    </div>
                    <div class="button-wrapper rabbit-cmd5">
                        <img src="res/thanksgiving_room_command5_unpressed.png"
                             class="floor-button game-command" data-command="command5">
                    </div>
                    <div class="button-wrapper rabbit-cmd7">
                        <img src="res/thanksgiving_room_command7_unpressed.png"
                             class="floor-button game-command" data-command="command7">
                    </div>
                </div>
            </div>`;

        floorContainer.querySelectorAll('.game-command').forEach(setupButtonListeners);
    };

    // --- Bot pig button visual flash ---
    const flashBotButton = (commandId) => {
        const btn = document.querySelector(`.bot-command[data-command="command${commandId}"]`);
        if (!btn || !btn.src) return;
        if (btn.src.includes('_unpressed.png')) {
            btn.src = btn.src.replace('_unpressed.png', '_pressed.png');
            setTimeout(() => {
                if (btn.src && btn.src.includes('_pressed.png'))
                    btn.src = btn.src.replace('_pressed.png', '_unpressed.png');
            }, 80);
        }
    };

    // --- Correct input (player or bot) ---
    const handleCorrectInput = (commandId = 8) => {
        playSfx(commandId);

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

    // --- Process next (mash mode: just update glow, success after 1s buffer) ---
    const processNextCommand = () => {
        if (gameFailed) return;
        if (currentGameIndex >= gamePattern.length) {
            mashSuccessTimer = setTimeout(() => onRoundEnd(true), 1000);
            return;
        }
        updateGlowIndicator();
    };

    // --- Process next (okma mode: bot handles pig commands, player handles t=8) ---
    const processOkmaNextCommand = () => {
        if (gameFailed) return;
        if (currentGameIndex >= gamePattern.length) {
            onRoundEnd(true);
            return;
        }

        updateGlowIndicator();

        const commandId = gamePattern[currentGameIndex];
        const isPig = [1, 2, 3, 6].includes(commandId);

        if (isPig) {
            let delay = OKMA_BOT_DELAYS.press_delays_ms[commandId] || 50;
            if (currentGameIndex === 0) {
                delay += OKMA_BOT_DELAYS.initial_reaction_delay_ms;
            }
            okmaBotActionTimeout = setTimeout(() => {
                if (gameFailed) return;
                flashBotButton(commandId);
                handleCorrectInput(commandId);
                processOkmaNextCommand();
            }, delay);
        }
        // commandId === 8: wait for player press
    };

    // --- Player input ---
    const handlePlayerInput = (commandId) => {
        if (gameFailed) return;

        if (activeTab === 'okma') {
            if (currentGameIndex >= gamePattern.length) {
                onRoundEnd(false);
                return;
            }
            const expected = gamePattern[currentGameIndex];
            if (![4, 5, 7, 8].includes(expected)) {
                onRoundEnd(false); // pressed during pig bot's turn
                return;
            }

            if (commandId !== expected) {
                onRoundEnd(false); // wrong rabbit button
                return;
            }

            if (okmaRabbitPressCount === 0) firstPressTime = performance.now();
            okmaRabbitPressCount++;
            handleCorrectInput(commandId);
            processOkmaNextCommand();
            return;
        }

        // Mash mode: only command 8
        if (commandId !== 8) return;

        if (currentGameIndex >= gamePattern.length) {
            if (mashSuccessTimer) { clearTimeout(mashSuccessTimer); mashSuccessTimer = null; }
            onRoundEnd(false);
            return;
        }

        if (currentGameIndex === 0) firstPressTime = performance.now();
        handleCorrectInput(8);
        processNextCommand();
    };

    // --- Round end ---
    const onRoundEnd = (isSuccess) => {
        gameFailed = true;
        if (okmaBotActionTimeout) { clearTimeout(okmaBotActionTimeout); okmaBotActionTimeout = null; }
        if (roundTimer) { clearTimeout(roundTimer); roundTimer = null; }

        if (isSuccess) {
            if (glowAnimationInterval) clearInterval(glowAnimationInterval);
            const glowEl = gameScreen.querySelector('.glow-indicator');
            if (glowEl) glowEl.classList.add('hidden');

            const scrollContent = gameScreen.querySelector('.scroll-content');
            if (scrollContent) scrollContent.style.display = 'none';

            if (activeTab === 'okma') {
                showToast('성공');
            } else {
                const totalTimeMs = lastPressTime - firstPressTime;
                const count       = gamePattern.length;
                lastScore = { count, totalTimeMs, points: calcScore(count, totalTimeMs) };
                renderScoreDisplay(gameScreen.querySelector('#round-display'), lastScore);
            }
            playSfx('success');
        } else {
            showMissAnimation();
            playSfx('fail');
            showToast('실패');
        }

        nextRoundTimeoutId = setTimeout(startNewRound, 1000);
    };

    const startNewRound = () => showGameScreen();

    // --- Show game screen ---
    const showGameScreen = async () => {
        if (nextRoundTimeoutId)    { clearTimeout(nextRoundTimeoutId);   nextRoundTimeoutId   = null; }
        if (mashSuccessTimer)      { clearTimeout(mashSuccessTimer);      mashSuccessTimer     = null; }
        if (okmaBotActionTimeout)  { clearTimeout(okmaBotActionTimeout);  okmaBotActionTimeout = null; }
        if (roundTimer)            { clearTimeout(roundTimer);            roundTimer           = null; }
        if (glowAnimationInterval) { clearInterval(glowAnimationInterval); glowAnimationInterval = null; }
        if (missAnimationInterval) { clearInterval(missAnimationInterval); missAnimationInterval = null; }

        if (audioContext && audioContext.state === 'suspended') audioContext.resume();

        gamePattern          = generatePattern();
        currentGameIndex     = 0;
        gameFailed           = false;
        firstPressTime       = 0;
        lastPressTime        = 0;
        okmaRabbitPressCount = 0;

        gameScreen.classList.remove('hidden');

        const getIconPath = (id) => {
            if ([1, 2, 3, 6].includes(id)) return `res/thanksgiving2024_room_command${id}.png`;
            return `res/thanksgiving_room_command${id}.png`;
        };

        const rows = [];
        for (let i = 0; i < gamePattern.length; i += 6) {
            const row = gamePattern.slice(i, i + 6);
            rows.push(`
                <div class="command-box">
                    ${row.map(id => `
                        <div class="command-icon-wrapper">
                            <img src="${getIconPath(id)}" class="command-icon">
                            <img class="miss-overlay hidden">
                        </div>`).join('')}
                </div>`);
        }

        const savedFloor = gameScreen.querySelector('.floor-container');
        const savedMode  = savedFloor ? savedFloor.dataset.mode : null;
        if (savedFloor) savedFloor.remove();

        const ceilingContent = activeTab === 'okma'
            ? `<div class="timer-container">
                   <img src="res/thanksgiving_room_time_bar.png" class="timer-bg">
                   <div class="timer-gauge-wrapper"><div class="timer-gauge"></div></div>
                   <img src="res/thanksgiving_room_time_gauge.png" class="timer-overlay">
                   <img src="res/thanksgiving_room_time_icon.png" class="timer-icon">
               </div>`
            : `<div id="round-display"></div>`;

        gameScreen.innerHTML = `
            <div class="ceiling">${ceilingContent}</div>
            <div class="game-area">
                <img class="glow-indicator hidden">
                <div class="scroll-viewport">
                    <div class="scroll-content">${rows.join('')}</div>
                </div>
            </div>
            <div class="floor-container"></div>`;

        if (activeTab !== 'okma') {
            renderScoreDisplay(gameScreen.querySelector('#round-display'), lastScore);
        }

        await Promise.all(
            Array.from(gameScreen.querySelectorAll('.command-icon'))
                .map(img => img.decode().catch(() => {}))
        );

        if (savedFloor && savedMode === activeTab) {
            gameScreen.querySelector('.floor-container').replaceWith(savedFloor);
        } else {
            if (activeTab === 'okma') renderOkmaFloorButtons();
            else renderFloorButtons();
        }

        positionGlowReliably();

        if (activeTab === 'okma') {
            const timeLimit = okmaSidan ? 3 : 4;

            roundTimer = setTimeout(() => {
                if (gameFailed) return;
                onRoundEnd(false);
            }, timeLimit * 1000);

            const gauge = gameScreen.querySelector('.timer-gauge');
            if (gauge) {
                gauge.style.transition = 'none';
                gauge.style.width = '100%';
                gauge.offsetHeight;
                gauge.style.transition = `width ${timeLimit}s linear`;
                gauge.style.width = '0%';
            }

            processOkmaNextCommand();
        } else {
            processNextCommand();
        }
    };

    // --- Button listeners ---
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

    // --- Tab switching ---
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            if (tab === activeTab) return;
            activeTab = tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
            document.getElementById('mash-controls').classList.toggle('hidden', tab !== 'mash');
            document.getElementById('okma-controls').classList.toggle('hidden', tab !== 'okma');
            lastScore = null;
            showGameScreen();
        });
    });

    // --- Difficulty change ---
    document.querySelectorAll('input[name="okma-diff"]').forEach(radio => {
        radio.addEventListener('change', () => {
            okmaDifficulty = parseInt(radio.value, 10);
            if (activeTab === 'okma') { lastScore = null; showGameScreen(); }
        });
    });

    document.getElementById('okma-sidan').addEventListener('change', function () {
        okmaSidan = this.checked;
        if (activeTab === 'okma') { lastScore = null; showGameScreen(); }
    });

    // --- Init ---
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
            'res/thanksgiving_room_command4.png',
            'res/thanksgiving_room_command4_off.png',
            'res/thanksgiving_room_command4_pressed.png',
            'res/thanksgiving_room_command4_unpressed.png',
            'res/thanksgiving_room_command5.png',
            'res/thanksgiving_room_command5_off.png',
            'res/thanksgiving_room_command5_pressed.png',
            'res/thanksgiving_room_command5_unpressed.png',
            'res/thanksgiving_room_command7.png',
            'res/thanksgiving_room_command7_off.png',
            'res/thanksgiving_room_command7_pressed.png',
            'res/thanksgiving_room_command7_unpressed.png',
            'res/thanksgiving2024_room_command1.png',
            'res/thanksgiving2024_room_command1_off.png',
            'res/thanksgiving2024_room_command1_pressed.png',
            'res/thanksgiving2024_room_command1_unpressed.png',
            'res/thanksgiving2024_room_command2.png',
            'res/thanksgiving2024_room_command2_off.png',
            'res/thanksgiving2024_room_command2_pressed.png',
            'res/thanksgiving2024_room_command2_unpressed.png',
            'res/thanksgiving2024_room_command3.png',
            'res/thanksgiving2024_room_command3_off.png',
            'res/thanksgiving2024_room_command3_pressed.png',
            'res/thanksgiving2024_room_command3_unpressed.png',
            'res/thanksgiving2024_room_command6.png',
            'res/thanksgiving2024_room_command6_off.png',
            'res/thanksgiving2024_room_command6_pressed.png',
            'res/thanksgiving2024_room_command6_unpressed.png',
            'res/thanksgiving_room_container_top.png',
            'res/thanksgiving_room_exit_unpressed.png',
            'res/thanksgiving_room_time_bar.png',
            'res/thanksgiving_room_time_gauge.png',
            'res/thanksgiving_room_time_icon.png',
            ...pigGlowFrames,
            ...rabbitGlowFrames,
            ...rabbitMissFrames,
        ]);

        loadingOverlay.classList.add('hidden');
        showGameScreen();
    };

    initializeApp();
});
