#!/usr/bin/env bash
# @name: todo-list
# @description: List TODO/FIXME comments in the project with file and line
# @tags: todo, fixme, tasks
# @readonly
rg -n --no-heading 'TODO|FIXME' "${1:-.}" || echo "no TODOs"
