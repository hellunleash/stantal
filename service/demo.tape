# A terminal demo, as code.
#
#   vhs service/demo.tape
#
# Runs the real commands in a real shell and records what actually happens. It
# is not a mockup and it is not edited — which matters more here than for most
# products, since the whole claim is that we do not fabricate anything. If the
# output changes, this is re-run and the recording changes with it.
#
# Install: brew install vhs   (or: go install github.com/charmbracelet/vhs@latest)

Output service/demo.webm
Output service/demo.gif

# WebM for the page, GIF for GitHub and anywhere that will not play video.
# A GIF of a terminal is usually 5-10 MB; the same thing as WebM is nearer 200 KB.

Require npx

Set Shell bash
Set FontSize 16
Set Width 1100
Set Height 620
Set Padding 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set BorderRadius 10

# Somewhere with real dependencies installed, so nothing on screen is invented.
Type "cd demo-project" Sleep 400ms Enter
Sleep 600ms
Ctrl+L

Type "npx stantal connect"
Sleep 900ms
Enter
Sleep 6s

Ctrl+L
Sleep 400ms

# The second half is the part that sells it: a test that did not exist, which
# now fails because the dependency moved underneath it.
Type "npx stantal pin @modelcontextprotocol/server-filesystem"
Sleep 700ms
Enter
Sleep 6s

Type "npm install @modelcontextprotocol/server-filesystem@0.5.0"
Sleep 700ms
Enter
Sleep 8s

Ctrl+L
Sleep 300ms

Type "npx vitest run"
Sleep 700ms
Enter
Sleep 8s

Sleep 3s
