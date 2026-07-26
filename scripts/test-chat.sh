#!/usr/bin/env bash
set -euo pipefail

# 仅验证 LiteLLM、模型配置和上游连通性；不得作为平台业务或普通客户端接入入口。
BASE_URL="${BASE_URL:-http://localhost:4000}"
API_KEY="${LITELLM_MASTER_KEY:-sk-local-admin-key}"

curl "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chat-default",
    "messages": [
      {
        "role": "user",
        "content": "用一句话介绍 LiteLLM。"
      }
    ]
  }'
