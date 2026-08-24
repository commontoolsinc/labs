## M1 — topics-navigation.test.ts (pass/fail + wall clock)

| run | arm | rc | wall_s | txerr | drops | store a/d |
|---|---|---|---|---|---|---|
| t1-off | OFF | 0 | 32 | 0 | 0 | 79/0 |
| t2-off | OFF | 0 | 8 | 0 | 0 | 77/0 |
| t3-off | OFF | 0 | 8 | 0 | 0 | 79/0 |
| t4-off | OFF | 0 | 11 | 0 | 0 | 79/0 |
| t5-off | OFF | 0 | 11 | 0 | 0 | 79/0 |
| t6-off | OFF | 0 | 8 | 0 | 0 | 77/0 |
| t1-on | ON | 0 | 24 | 0 | 0 | 7/33 |
| t2-on | ON | 0 | 12 | 0 | 0 | 8/31 |
| t3-on | ON | 0 | 12 | 0 | 0 | 7/30 |
| t4-on | ON | 0 | 11 | 0 | 0 | 7/29 |
| t5-on | ON | 0 | 21 | 0 | 0 | 8/30 |
| t6-on | ON | 0 | 12 | 0 | 0 | 7/29 |

OFF: n=6 green=6 wall median=8s min=8s max=32s

ON: n=6 green=6 wall median=12s min=11s max=24s

## M2 — topics journey benchmark (n per arm = runs)

| step (ms) | OFF p50/p90 (min-max) | ON p50/p90 (min-max) |
|---|---|---|
| board create + start (controller) | 2406 / 4254 (1971-5463) n=10 | 1854 / 2527 (1450-3424) n=10 |
| addTopic seed 1 echo (controller) | 433 / 836 (342-1220) n=10 | 1630 / 2284 (1339-2822) n=10 |
| addTopic seed 2 echo (controller) | 345 / 630 (261-671) n=10 | 410 / 945 (280-1143) n=10 |
| fid capture (result.pull + resolveAsCell x2) | 37 / 64 (25-71) n=10 | 35 / 52 (26-56) n=10 |
| browser cold load: goto + login | 591 / 954 (427-970) n=10 | 644 / 802 (578-862) n=10 |
| browser runtime idle | 10 / 16 (3-25) n=10 | 4 / 13 (2-30) n=10 |
| browser renders both seed titles | 1067 / 1850 (586-1913) n=10 | 970 / 1452 (455-1585) n=10 |
| navigate-to-topic: click Open -> piece view | 43 / 50 (34-50) n=10 | 44 / 53 (27-65) n=10 |
| post-navigation runtime idle | 7 / 34 (2-43) n=10 | 34 / 49 (2-57) n=10 |
| TOTAL journey | 4905 / 9019 (3820-9675) n=10 | 5707 / 7094 (4455-9810) n=10 |

**Pooled per-event series (echo=controller's own render analog; arrival=other surface's browser render; gap=arrival-echo):**

| series (ms) | arm | n | p50 | p90 | p95 | min | max |
|---|---|---|---|---|---|---|---|
| echo | OFF | 200 | 732 | 1145 | 1436 | 280 | 2147 |
| echo | ON | 200 | 1408 | 2693 | 3370 | 580 | 4624 |
| arrival | OFF | 200 | 977 | 1598 | 1805 | 304 | 3010 |
| arrival | ON | 200 | 1473 | 2840 | 3553 | 599 | 4798 |
| gap | OFF | 200 | 252 | 530 | 619 | 21 | 891 |
| gap | ON | 200 | 59 | 134 | 156 | 17 | 188 |

Per-run medians (echo->arrival), for variance:
  OFF: j1-off:563->769 j10-off:459->625 j2-off:745->984 j3-off:747->991 j4-off:734->1034 j5-off:734->954 j6-off:1250->1552 j7-off:781->982 j8-off:641->931 j9-off:680->896
  ON: j1-on:1191->1236 j10-on:1198->1236 j2-on:2426->2545 j3-on:1268->1310 j4-on:1477->1560 j5-on:2199->2321 j6-on:1470->1527 j7-on:1346->1405 j8-on:1322->1376 j9-on:1328->1380
  seed-echo OFF: seed1 p50=433 max=1220; seed2 p50=345 max=671
  seed-echo ON: seed1 p50=1629 max=2822; seed2 p50=410 max=1143

## Server settle-time series (OW38(ii)) — ON runs

| run | n | ALL-INPUTS p50/p95/max | value-only p50/p95/max (n) | growth n; toLanding p50/p95/max; coverage p50 | event-append p50/p95 (n) | advances | derived/authored/acks |
|---|---|---|---|---|---|---|---|
| j1-on | 27 | 19/1956/3131 | 36/612/612 (3) | 24; 1115/2105/6094; 19 | 19/51 (23) | 26 (d=0) | 181/27/0 |
| j10-on | 28 | 19/1465/2316 | 26/672/672 (4) | 24; 1043/1762/2372; 19 | 19/245 (23) | 26 (d=0) | 173/28/0 |
| j2-on | 28 | 28/1554/2294 | 69/711/711 (3) | 25; 1672/3969/4745; 28 | 28/76 (23) | 27 (d=0) | 211/28/0 |
| j3-on | 28 | 19/2861/5788 | 26/688/688 (4) | 24; 1070/2947/5922; 19 | 19/548 (23) | 26 (d=0) | 184/28/0 |
| j4-on | 28 | 21/2540/3757 | 38/2113/2113 (5) | 23; 1294/2680/3841; 19 | 19/983 (23) | 26 (d=0) | 185/28/0 |
| j5-on | 27 | 36/3472/4607 | 29/1267/1267 (2) | 25; 1765/3717/10283; 36 | 35/84 (23) | 27 (d=0) | 213/27/0 |
| j6-on | 28 | 31/2131/3074 | 32/1608/1608 (3) | 25; 1291/4005/4207; 31 | 29/68 (23) | 26 (d=0) | 213/28/0 |
| j7-on | 28 | 21/1652/2780 | 16/53/53 (2) | 26; 1194/2253/5298; 21 | 21/51 (23) | 27 (d=0) | 189/28/0 |
| j8-on | 28 | 30/1920/2858 | 19/19/19 (1) | 27; 1146/2931/3026; 32 | 28/49 (23) | 27 (d=0) | 192/28/0 |
| j9-on | 28 | 21/1814/2770 | 33/669/669 (3) | 25; 1194/1921/5450; 21 | 20/52 (23) | 26 (d=0) | 185/28/0 |
| t1-on | 7 | 109/5390/5390 | 60/3067/3067 (3) | 4; 866/10767/10767; 109 | 109/3067 (3) | 7 (d=0) | 33/7/0 |
| t2-on | 8 | 38/2731/2731 | 20/38/38 (2) | 6; 568/5411/5411; 74 | 74/513 (3) | 7 (d=0) | 31/8/0 |
| t3-on | 7 | 81/2543/2543 | 20/20/20 (1) | 6; 573/5221/5221; 81 | 81/545 (3) | 7 (d=0) | 30/7/0 |
| t4-on | 7 | 60/2645/2645 | 16/16/16 (1) | 6; 694/2714/2714; 60 | 15/628 (2) | 5 (d=0) | 29/7/0 |
| t5-on | 8 | 73/4866/4866 | 29/1913/1913 (3) | 5; 711/5040/5040; 120 | 73/1913 (3) | 7 (d=0) | 30/8/0 |
| t6-on | 7 | 57/3808/3808 | 29/857/857 (3) | 4; 520/3921/3921; 57 | 17/857 (2) | 7 (d=0) | 29/7/0 |

POOLED ON: all-inputs n=322 p50=22 p90=1652 p95=2731 max=5788; value-only n=43 p50=32 p95=1913; growth-to-landing n=279 p50=1227 p95=3921 max=10767; growth-coverage p50=22

OFF witness: every OFF run's stats-post lacks servingLoop; every ON run carries it (no posture breaks).
