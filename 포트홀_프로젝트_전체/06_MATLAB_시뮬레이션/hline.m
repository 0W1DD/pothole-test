function hline(y, style, label)
% 가로 기준선 그리기 (옛 MATLAB 버전에서도 동작)
hold on;
xl = xlim;
plot(xl, [y y], style, 'LineWidth', 1.2);
xlim(xl);
if nargin > 2
    text(xl(1), y, ['  ' label], 'VerticalAlignment', 'bottom', 'Color', [0.8 0 0]);
end
end
