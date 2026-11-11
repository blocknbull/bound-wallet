// Every word on the section cards and the live panel, for both videos.
// section.html?c=<key>&n=<number> shows one of `sections`;
// live.html?n=<number>&beats=<key>:<seconds>,... shows `beats` in that order.
// The build scripts choose which and for how long; the wording lives here.
window.COPY = {
  sections: {
    key: {
      label: 'Access keys',
      title: 'The blind spot',
      sub: 'A NEAR access key caps gas. It never sees the money.',
    },
    pay: {
      label: 'x402 payment',
      title: 'Pays its own way',
      sub: 'An x402 paywall, settled by the agent. Small calls clear. Big ones wait for the owner.',
    },
    attack: {
      label: 'Prompt injection',
      title: 'Hijacked',
      sub: 'A prompt-injected agent tries to pay an attacker. The contract refuses, then suspends it.',
    },
    swarm: {
      label: 'Agent swarm',
      title: 'Blast radius',
      sub: 'One worker in the swarm is compromised. The damage stops at its own wallet.',
    },
  },
  live: { label: 'Live on mainnet', account: 'agents.boundwallet.near' },
  beats: {
    switch: {
      title: 'You hold the switch',
      sub: 'Funds set aside for agents, one kill switch, and a payment waiting for your yes.',
    },
    limits: {
      title: 'Custom limits',
      sub: '$10 per action. $25 a day. One address it can pay.',
    },
    asks: {
      title: 'It asks first',
      sub: 'Anything above 0.25 NEAR waits in a queue for the owner.',
    },
    log: {
      title: 'Every call, on chain',
      sub: 'Asked, approved, denied, tripwired. Anyone can read the log.',
    },
  },
};
