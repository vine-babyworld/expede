export function playBeep(success: boolean) {
  try {
    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "square";
    osc.frequency.value = success ? 1200 : 200;
    gain.gain.value = 0.15;
    osc.start();
    setTimeout(
      () => {
        osc.stop();
        ctx.close();
      },
      success ? 100 : 400,
    );
  } catch {
    // ignore
  }
}
