# kill any deno process on 5173 and 8000
lsof -ti:5173 | xargs -r ps -p | grep deno | awk '{print $1}' | xargs -r kill -9
lsof -ti:8000 | xargs -r ps -p | grep deno | awk '{print $1}' | xargs -r kill -9
