PORT ?= 8787
NODE_IMAGE ?= node:24-alpine
ZIP := lan-drop-extension.zip

# 一次性容器里的 Node：本机不用装 Node / tsc。挂当前目录，用调用者的 uid 跑，
# 免得产物变成 root 所有；npm 的缓存和 HOME 指到 /tmp，因为非 root 写不了 /。
DOCKER_NODE = docker run --rm -v "$(CURDIR)":/app -w /app \
	-u $$(id -u):$$(id -g) -e HOME=/tmp -e npm_config_cache=/tmp/.npm $(NODE_IMAGE)

# protocol.ts 是纯类型文件，编译产物是空壳，删掉
# offscreen.ts 引了 @noble/*，Chrome 扩展不支持 bare specifier，用 esbuild 打成单文件
BUILD_CMD = npm run build && rm -f extension/protocol.js extension/protocol.js.map \
	extension/crypto-primitives.js extension/crypto-primitives.js.map \
	extension/identity.js extension/identity.js.map \
	extension/noise.js extension/noise.js.map \
	extension/secure-channel.js extension/secure-channel.js.map \
	&& npx esbuild src/offscreen.ts --bundle --format=esm --outfile=extension/offscreen.js --sourcemap

.DEFAULT_GOAL := help
.PHONY: help build watch typecheck test serve up down logs ip zip clean build-docker test-docker

help: ## 显示所有命令
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

# 依赖装好了就不重复装；package.json 变了才重新 npm install
node_modules: package.json
	npm install
	@touch node_modules

build: node_modules ## 编译扩展：src/*.ts → extension/*.js
	@$(BUILD_CMD)

build-docker: ## 同 build，但在一次性容器里跑（本机不用装 Node）
	$(DOCKER_NODE) sh -c "npm ci && $(BUILD_CMD)"

test-docker: ## 同 test，但在一次性容器里跑
	$(DOCKER_NODE) sh -c "npm ci && npm test"

watch: node_modules ## 编译扩展，改动即重编译
	npm run watch

typecheck: node_modules ## 类型检查扩展与服务端两套配置
	npm run typecheck

test: node_modules ## 跑测试（信令服务端 + 自动发现）
	npm test

serve: node_modules ## 直接用 Node 起信令服务（不走 Docker）
	PORT=$(PORT) npm start

up: ## 用 Docker 起信令服务（后台常驻）
	PORT=$(PORT) docker compose up -d --build
	@$(MAKE) --no-print-directory ip

down: ## 停掉 Docker 里的信令服务
	docker compose down

logs: ## 跟踪信令服务日志
	docker compose logs -f

ip: ## 打印该填进扩展设置里的信令地址
	@addr=$$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $$1}'); \
	echo "信令地址：ws://$${addr:-<本机局域网IP>}:$(PORT)"

zip: ## 把 extension/ 打包成可分发的 zip
	@test -f extension/popup.js || { echo "先跑 make build 或 make build-docker"; exit 1; }
	@rm -f $(ZIP)
	cd extension && zip -qr ../$(ZIP) . -x '*.map'
	@echo "已生成 $(ZIP)"

clean: ## 删掉编译产物
	rm -f extension/*.js extension/*.js.map $(ZIP)
