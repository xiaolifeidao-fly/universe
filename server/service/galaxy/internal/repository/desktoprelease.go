package repository

import (
	"context"
	"time"

	"gorm.io/gorm/clause"
)

// 桌面客户端（Nova / Orbit）安装包的元数据。字节在 OSS，这里只回答
// 「发过哪些版本、现在这个通道该发哪一份清单」。
//
// 和 bridgerelease.go 一样：版本高低不在 SQL 里排（字符串序会让 0.10.0 小于 0.9.0），
// 这一层只负责取行，谁是「当前版本」由 service/galaxy/desktoprelease.go 算。

// SaveDesktopRelease 写一行发版记录。同一个端 + 通道 + 版本只有一行：
// 重新上传就是覆盖它（service 层只在这一行不是 published 时才允许覆盖）。
func (r *GalaxyRepository) SaveDesktopRelease(ctx context.Context, row *GalaxyDesktopRelease) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "biz_line"}, {Name: "product"}, {Name: "channel"}, {Name: "version"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"release_id", "manifest_file", "manifest", "files_json", "size",
			"notes", "status", "published_by", "published_at", "updated_time",
		}),
	}).Create(row).Error
}

func (r *GalaxyRepository) FindDesktopRelease(ctx context.Context, bizLine, releaseID string) (*GalaxyDesktopRelease, error) {
	var row GalaxyDesktopRelease
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("release_id = ?", releaseID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// FindDesktopReleaseTarget 按「端 + 通道 + 版本」取一行。重新上传时用它判断要不要拦。
func (r *GalaxyRepository) FindDesktopReleaseTarget(ctx context.Context, bizLine, product, channel, version string) (*GalaxyDesktopRelease, error) {
	var row GalaxyDesktopRelease
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("product = ?", product).Where("channel = ?", channel).Where("version = ?", version).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ListDesktopReleases 全部发版记录。publishedOnly 为真时只要在架的那些 ——
// 写到 OSS 上的清单只在在架的里面挑，运营列表要看全部（含待上传与已下架的）。
//
// product 为空表示两个端都要。
func (r *GalaxyRepository) ListDesktopReleases(ctx context.Context, bizLine, product string, publishedOnly bool) ([]*GalaxyDesktopRelease, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyDesktopRelease{}).Where("biz_line = ?", bizLine)
	if product != "" {
		tx = tx.Where("product = ?", product)
	}
	if publishedOnly {
		tx = tx.Where("status = ?", "published")
	}
	var rows []*GalaxyDesktopRelease
	// 按上传时间兜底排一次，语义版本的序由 service 层重排；这样同一批行
	// 不会因为两次查询的返回顺序不同而在页面上跳来跳去。
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, err
}

// SetDesktopReleaseStatus 上架 / 下架。返回 false 表示没有这一行。
func (r *GalaxyRepository) SetDesktopReleaseStatus(ctx context.Context, bizLine, releaseID, status string, publishedAt *time.Time, operator string) (bool, error) {
	fields := map[string]any{"status": status}
	if publishedAt != nil {
		fields["published_at"] = *publishedAt
	}
	if operator != "" {
		fields["published_by"] = operator
	}
	result := r.Db.WithContext(ctx).Model(&GalaxyDesktopRelease{}).
		Where("biz_line = ?", bizLine).Where("release_id = ?", releaseID).
		Updates(fields)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}
