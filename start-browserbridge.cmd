@echo off
rem Starts the Browser Bridge Ext hub headlessly (no stdin needed); MCP sessions and browsers attach to it.
node "%~dp0dist\bridge.cjs" serve
