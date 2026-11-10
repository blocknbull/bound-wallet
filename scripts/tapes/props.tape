# The policy engine's property tests, and the guard that keeps them honest.
# Render:  vhs scripts/tapes/props.tape
Output recordings/props.mp4

Set Shell bash
Set FontSize 20
Set Width 1920
Set Height 1080
Set Padding 40
Set TypingSpeed 45ms
Set Theme { "background": "#0b0b10", "foreground": "#e6e6f0", "black": "#15151c", "red": "#ff6b6b", "green": "#5ad4a0", "yellow": "#e8c547", "blue": "#7c6cff", "magenta": "#b48cff", "cyan": "#6fd6e8", "white": "#e6e6f0", "brightBlack": "#5a5a6a", "brightRed": "#ff8a8a", "brightGreen": "#7ee6ba", "brightYellow": "#f3d66b", "brightBlue": "#9a8cff", "brightMagenta": "#c9aaff", "brightCyan": "#8fe3f2", "brightWhite": "#ffffff", "cursor": "#b48cff", "selection": "#2a2a3a" }

Hide
Type "cd ~/NearWallet/contract && cargo test --lib >/dev/null 2>&1 && clear" Enter
Sleep 25s
Show

Sleep 1s
Type "grep -B2 -A3 'first version of these tests' src/policy.rs"
Sleep 600ms
Enter
Sleep 4s

Type "cargo test --lib -- --nocapture 2>&1 | grep -E 'props::|coverage over|test result'"
Sleep 600ms
Enter
Sleep 7s
