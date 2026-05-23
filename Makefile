.PHONY: setup run test test-watch typecheck build lint fmt clean

setup:
	npm install

run:
	npm run dev

test:
	npm test

test-watch:
	npm run test:watch

typecheck:
	npm run typecheck

build:
	npm run build

lint:
	# Phase 1: typecheck only. eslint (@typescript-eslint) lands in Phase 3 tooling.
	tsc --noEmit

fmt:
	# Phase 3 tooling: prettier will be wired here. No-op for now.

clean:
	rm -rf dist/
