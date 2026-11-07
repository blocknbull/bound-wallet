# Pay-per-request under policy: 402, pay, retry, 200 - then one above the
# approval threshold, then one refused by the client ceiling.
# For the 32-46s slot.  Render:  vhs scripts/tapes/x402.tape

Output recordings/x402.mp4

Set Shell bash
Set FontSize 22
Set Width 1920
Set Height 1080
Set Padding 40
Set TypingSpeed 55ms
Set Theme { "background": "#0b0b10", "foreground": "#e6e6f0", "black": "#15151c", "red": "#ff6b6b", "green": "#5ad4a0", "yellow": "#e8c547", "blue": "#7c6cff", "magenta": "#b48cff", "cyan": "#6fd6e8", "white": "#e6e6f0", "brightBlack": "#5a5a6a", "brightRed": "#ff8a8a", "brightGreen": "#7ee6ba", "brightYellow": "#f3d66b", "brightBlue": "#9a8cff", "brightMagenta": "#c9aaff", "brightCyan": "#8fe3f2", "brightWhite": "#ffffff", "cursor": "#b48cff", "selection": "#2a2a3a" }

Hide
Type "cd ~/NearWallet && clear" Enter
Sleep 2s
Show

Sleep 1s
Type "QUIET=1 ./scripts/x402-demo.sh .bound/buyer.guard.reins.testnet.json reins.testnet"
Sleep 800ms
Enter
Sleep 15s
