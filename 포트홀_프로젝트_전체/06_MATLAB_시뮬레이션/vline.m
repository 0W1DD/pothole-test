function vline(x, style)
% 세로선 그리기 (옛 MATLAB 버전에서도 동작)
hold on;
yl = ylim;
plot([x x], yl, style, 'LineWidth', 1.2);
ylim(yl);
end
