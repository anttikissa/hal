# Word lists

`web2.txt` is copied from macOS `/usr/share/dict/web2`.
The system README says it is Webster's Second International, with the 1934 copyright lapsed.

`session-name-words.txt` is the initial candidate list for session name postfixes:
all unique lowercase alphabetic three-letter words extracted from `web2.txt`.

`session-postfix-candidates.txt` is a more recognizable candidate list for session name postfixes.
It contains lowercase three-letter tokens that appear in at least two modern frequency sources:
Google 10k English, wordfreq-en-25000, and COCA top 5000.
It is sorted from least obscure to most obscure by normalized source ranks.

`session-postfix-candidates.tsv` has the same candidates with source ranks for review.
