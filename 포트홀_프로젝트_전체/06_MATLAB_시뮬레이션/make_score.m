function score = make_score(shock, window, fs)
% 충격 점수 = 최근 window 초 동안 shock 의 평균 (파이썬 Scorer 와 같은 방식)
k = max(1, round(window * fs));
score = movmean(shock(:), [k-1 0]);
end
