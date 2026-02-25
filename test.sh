#!/bin/bash
stty -icanon -echo
printf '\e[>31u'
cat -v
printf '\e[<u'
stty sane
