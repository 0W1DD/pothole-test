function [tp, sp] = find_peaks_greedy(t, score, n, cooldown)
% 점수 높은 순으로 보면서 cooldown 초 안에 겹치지 않는 봉우리 n 개 고르기
% (calibrate.py 의 find_events 와 같은 방식)
[s_sorted, order] = sort(score(:), 'descend');
t_sorted = t(order);
tp = zeros(0, 1); sp = zeros(0, 1);
for i = 1:numel(s_sorted)
    if all(abs(t_sorted(i) - tp) > cooldown)
        tp(end+1, 1) = t_sorted(i); %#ok<AGROW>
        sp(end+1, 1) = s_sorted(i); %#ok<AGROW>
        if numel(tp) >= n, break; end
    end
end
[tp, o] = sort(tp);
sp = sp(o);
end
