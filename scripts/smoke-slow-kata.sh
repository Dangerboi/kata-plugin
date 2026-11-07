#!/bin/sh
# Kata as a loaded machine serves it: every call starts KATA_SMOKE_DELAY seconds late.
sleep "${KATA_SMOKE_DELAY:-0.025}"
exec kata "$@"
