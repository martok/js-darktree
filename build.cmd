@echo on
call terser src/darktree.js -m -c -o darktree.min.js
sed -e "s/`/\\`/g" -e "s/${/\\${/g" darktree.min.js > darktree.min.jss
sed -e "s/`/\\`/g" -e "s/${/\\${/g" src/darktree.js > darktree.jss
