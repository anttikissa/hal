# HAL 9001

Hal is a terminal-based coding agent with the following goals:

- under 10k lines of TypeScript
- starts in 100ms on my reference machine (MacBook Air from 2020)
- no dependencies

Meanwhile, it tries to be reasonably feature complete, have a nice terminal and web UI.

# Install

git clone https://github.com/anttikissa/hal.git ~/.hal
cd ~/.hal
# You can skip this part but I wouldn't recommend it - for this or any other project
claude -p "I just downloaded this project from the internet and I'm about to run ./install, and then the executable that it installs. Do a security review to verify that it doesn't do anything nasty."

# Installs prerequisites. It's assumed that you already have 'git'.
./install

cd ~/my/project
hal
